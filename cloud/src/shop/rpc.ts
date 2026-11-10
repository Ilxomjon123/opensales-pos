import { DomainError, forbidden } from './errors'
import type { Sql } from './sql'

// RPC dispetcheri — Durable Object ham, node testlari ham shuni chaqiradi.
//
// Har op ro'yxatda (allowlist); noma'lum nom → 404. Huquq ikki bosqichli: token rolini
// emas, DO ichidagi `members` nusxasini o'qiydi (kassir o'chirilsa darhol ta'sir qiladi).
// Yozuvchi op'lar bitta tranzaksiyada idempotency yozuvi bilan: xato bo'lsa hammasi
// qaytariladi va kalit bo'sh qoladi (qayta urinish mumkin), muvaffaqiyat bo'lsa o'sha
// kalit bilan qayta kelgan so'rov SAQLANGAN javobni oladi (ikkinchi chek yo'q).

export type Role = 'owner' | 'cashier'
export type Actor = { uid: number; role: Role; name: string }

export type Ctx = {
  sql: Sql
  actor: Actor
  /** Joriy vaqt, ISO (desktop `new Date().toISOString()` bilan bir xil format). */
  now(): string
  /** Sozlama qiymati (settings jadvali). */
  setting(key: string, fallback?: string): string
  /** Rasm manzili (`products.image` dagi versiya belgisidan). */
  imageUrl(productId: number, version: string): string
}

export type OpDef = {
  /** 'cashier' — kassir ham (egasi doim); 'owner' — faqat egasi. */
  access: Role
  write: boolean
  /** Obuna tugaganda ham ruxsat (masalan, smenani yopish). */
  allowExpired?: boolean
  run(ctx: Ctx, args: unknown): unknown
}
export type OpTable = Record<string, OpDef>

export type RpcError = { code: string; params: Record<string, unknown>; status: number }
export type RpcResult = { ok: true; data: unknown; replayed?: boolean } | { ok: false; error: RpcError }

export type DispatchOpts = {
  idempotencyKey?: string | null
  /** Obuna faolmi (trial yoki to'langan). */
  subscriptionActive: boolean
  now?: () => string
  imageUrl?: (productId: number, version: string) => string
  /**
   * Platforma admini ko'rish rejimi: a'zolik tekshirilmaydi (Worker admin huquqini tekshirgan), rol — ega,
   * har qanday yozuvchi op rad etiladi (403) — hech narsa ishga tushmaydi.
   */
  viewOnly?: boolean
}

const KEY_RE = /^[A-Za-z0-9_-]{8,80}$/

// cyrb53 — kalit bilan kelgan so'rov tanasi o'zgarmaganini tekshirish uchun (kriptografik emas).
export function fingerprint(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function errorResult(e: unknown): RpcResult {
  if (e instanceof DomainError) return { ok: false, error: { code: e.code, params: e.params, status: e.status } }
  const msg = e instanceof Error ? e.message : String(e)
  // SQLite cheklovlari (unikal shtrix-kod va h.k.) — foydalanuvchiga tushunarli umumiy xato.
  if (/UNIQUE constraint failed/i.test(msg)) return { ok: false, error: { code: 'cloud.errors.conflict', params: {}, status: 409 } }
  if (/FOREIGN KEY constraint failed/i.test(msg)) return { ok: false, error: { code: 'cloud.errors.inUse', params: {}, status: 409 } }
  console.error('rpc internal error:', msg)
  return { ok: false, error: { code: 'cloud.errors.internal', params: {}, status: 500 } }
}

export function memberRole(sql: Sql, uid: number): Role | null {
  const m = sql.get<{ role: Role; active: number }>('SELECT role, active FROM members WHERE uid = ?', uid)
  return m && m.active ? m.role : null
}

export function dispatch(sql: Sql, ops: OpTable, op: string, args: unknown, actorIn: Actor, opts: DispatchOpts): RpcResult {
  try {
    const def = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : undefined
    if (!def) return { ok: false, error: { code: 'cloud.errors.unknownOp', params: { op }, status: 404 } }

    if (opts.viewOnly && def.write) return { ok: false, error: { code: 'cloud.admin.viewOnly', params: {}, status: 403 } }
    const role: Role | null = opts.viewOnly ? 'owner' : memberRole(sql, actorIn.uid)
    if (!role) return { ok: false, error: { code: 'cloud.errors.memberRevoked', params: {}, status: 403 } }
    if (def.access === 'owner' && role !== 'owner') throw forbidden()
    const actor: Actor = { ...actorIn, role }

    if (def.write && !opts.subscriptionActive && !def.allowExpired) {
      return { ok: false, error: { code: 'cloud.errors.subscriptionExpired', params: {}, status: 402 } }
    }

    const ctx: Ctx = {
      sql,
      actor,
      now: opts.now ?? (() => new Date().toISOString()),
      setting: (key, fallback = '') => sql.get<{ value: string | null }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback,
      imageUrl: opts.imageUrl ?? ((pid, ver) => `/img/${pid}/${ver}`),
    }

    if (!def.write) return { ok: true, data: def.run(ctx, args) ?? null }

    const key = opts.idempotencyKey ?? null
    if (key !== null && !KEY_RE.test(key)) return { ok: false, error: { code: 'cloud.errors.invalidInput', params: { field: 'idempotencyKey' }, status: 400 } }
    const fp = fingerprint(op + '\u0000' + JSON.stringify(args ?? null))

    return sql.tx((): RpcResult => {
      if (key !== null) {
        const prev = sql.get<{ op: string; fingerprint: string; response: string }>(
          'SELECT op, fingerprint, response FROM idempotency WHERE uid = ? AND key = ?', actor.uid, key,
        )
        if (prev) {
          if (prev.op !== op || prev.fingerprint !== fp) {
            return { ok: false, error: { code: 'cloud.errors.idempotencyMismatch', params: {}, status: 409 } }
          }
          return { ok: true, data: JSON.parse(prev.response), replayed: true }
        }
      }
      const data = def.run(ctx, args) ?? null
      if (key !== null) {
        sql.run(
          'INSERT INTO idempotency(key, uid, op, fingerprint, response, created_at) VALUES(?,?,?,?,?,?)',
          key, actor.uid, op, fp, JSON.stringify(data), ctx.now(),
        )
      }
      return { ok: true, data }
    })
  } catch (e) {
    return errorResult(e)
  }
}
