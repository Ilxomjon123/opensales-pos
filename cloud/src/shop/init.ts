import type { Role } from './rpc'
import type { Sql } from './sql'

// Do'konning bulutga xos holati: a'zolar nusxasi, obuna, boshlang'ich ma'lumot.
// Asl manba — D1 registry (Worker); DO o'z nusxasini Worker yuborgan qiymatdan yangilaydi,
// shunda har RPC'da D1'ga borilmaydi va kassirni o'chirish darhol kuchga kiradi.

export type MemberSync = { uid: number; name: string; role: Role; active: boolean }
export type Subscription = { trialUntil: string; paidUntil: string | null; status: 'active' | 'blocked' }

const WALK_IN_NAME = "Yo'l-yo'lakay xaridor"

function setMeta(sql: Sql, key: string, value: string | null) {
  sql.run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
}

/** AI yordamchi do'kon uchun yoqilganmi (admin o'chira oladi; yozuv yo'q — yoqilgan). */
export function aiEnabled(sql: Sql): boolean {
  return getMeta(sql, 'ai_enabled') !== '0'
}
export function setAiEnabled(sql: Sql, on: boolean) {
  setMeta(sql, 'ai_enabled', on ? '1' : '0')
}

export function getMeta(sql: Sql, key: string): string | null {
  return sql.get<{ value: string | null }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null
}

/** Birinchi marta (onboarding). Qayta chaqirilsa hech narsani buzmaydi. */
export function initShop(sql: Sql, p: { tenantId: string; shopName: string; owner: { uid: number; name: string }; subscription: Subscription; catalogOf?: string | null }, now: string) {
  sql.tx(() => {
    setMeta(sql, 'tenant_id', p.tenantId)
    // Filial: katalog boshqa do'kondan (faqat yaratilganda belgilanadi — keyin o'zgarmaydi).
    if (p.catalogOf && !getMeta(sql, 'catalog_of')) setMeta(sql, 'catalog_of', p.catalogOf)
    sql.run("INSERT OR IGNORE INTO settings(key, value) VALUES('currency_symbol', 'so''m')")
    sql.run("INSERT OR IGNORE INTO settings(key, value) VALUES('shop_name', ?)", p.shopName)
    const c = sql.get<{ c: number }>('SELECT COUNT(*) c FROM customers')
    if ((c?.c ?? 0) === 0) sql.run('INSERT INTO customers(name, is_walk_in) VALUES(?, 1)', WALK_IN_NAME)
    syncMember(sql, { uid: p.owner.uid, name: p.owner.name, role: 'owner', active: true }, now)
    setSubscription(sql, p.subscription)
  })
}

export function syncMember(sql: Sql, m: MemberSync, now: string) {
  sql.run(
    `INSERT INTO members(uid, name, role, active, updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET name = excluded.name, role = excluded.role, active = excluded.active, updated_at = excluded.updated_at`,
    m.uid, m.name, m.role, m.active ? 1 : 0, now,
  )
}

export function setSubscription(sql: Sql, s: Subscription) {
  setMeta(sql, 'trial_until', s.trialUntil)
  setMeta(sql, 'paid_until', s.paidUntil)
  setMeta(sql, 'status', s.status)
}

export function readSubscription(sql: Sql): Subscription | null {
  const trial = getMeta(sql, 'trial_until')
  if (!trial) return null
  return { trialUntil: trial, paidUntil: getMeta(sql, 'paid_until'), status: getMeta(sql, 'status') === 'blocked' ? 'blocked' : 'active' }
}

/** Faol: bloklanmagan va trial yoki to'lov muddati hali o'tmagan. */
export function isSubscriptionActive(s: Subscription | null, nowIso: string): boolean {
  if (!s || s.status === 'blocked') return false
  const until = [s.trialUntil, s.paidUntil].filter(Boolean).sort().pop()!
  return nowIso < until
}
