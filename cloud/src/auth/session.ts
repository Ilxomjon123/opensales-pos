// Sessiya tokeni: initData faqat kirishda tekshiriladi, keyin shu qisqa muddatli token.
// Format: `v1.<payload base64url>.<HMAC-SHA256 base64url>`. Server holatisiz — har so'rovda
// D1'ga borilmaydi; a'zo o'chirilgani DO'dagi members nusxasidan darhol ko'rinadi.

export type Role = 'owner' | 'cashier'

export type SessionPayload = {
  /** tenant id */
  t: string
  /** Telegram user id */
  u: number
  r: Role
  /** ko'rinadigan ism */
  n: string
  /** berilgan vaqt (soniya) */
  iat: number
  /** amal qilish muddati (soniya) */
  exp: number
  /** yangilash mumkin bo'lgan eng oxirgi payt (soniya) — kirishdan 30 kun */
  abs: number
  /**
   * 1 — platforma admini do'konni KO'RISH rejimida (a'zo emas): faqat o'qish op'lari, boshqa endpoint'lar
   * rad etiladi (index.ts → viewGuard). Imzo ichida — klient o'zgartira olmaydi.
   */
  v?: 1
}

export const SESSION_TTL = 12 * 3600
export const SESSION_ABSOLUTE = 30 * 86400

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch { return null }
}

async function key(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

export async function signSession(p: Omit<SessionPayload, 'iat' | 'exp' | 'abs'> & { abs?: number }, secret: string, nowSec: number): Promise<string> {
  if (!secret || secret.length < 32) throw new Error('SESSION_KEY is missing or too short')
  const abs = p.abs ?? nowSec + SESSION_ABSOLUTE
  const payload: SessionPayload = { t: p.t, u: p.u, r: p.r, n: p.n, iat: nowSec, exp: Math.min(nowSec + SESSION_TTL, abs), abs, ...(p.v === 1 ? { v: 1 as const } : {}) }
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, 'sign'), enc.encode('v1.' + body)))
  return `v1.${body}.${b64url(sig)}`
}

/**
 * Imzo to'g'ri bo'lsa payload. `allowExpired` — yangilash (refresh) uchun: muddati o'tgan,
 * lekin absolyut chegaradan oshmagan token qabul qilinadi.
 */
export async function verifySession(token: string, secret: string, nowSec: number, opts: { allowExpired?: boolean } = {}): Promise<SessionPayload | null> {
  if (!token || token.length > 2048 || !secret) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const sig = fromB64url(parts[2])
  const body = fromB64url(parts[1])
  if (!sig || !body) return null
  const ok = await crypto.subtle.verify('HMAC', await key(secret, 'verify'), sig, enc.encode('v1.' + parts[1]))
  if (!ok) return null
  let p: SessionPayload
  try { p = JSON.parse(new TextDecoder().decode(body)) } catch { return null }
  if (typeof p.t !== 'string' || typeof p.u !== 'number' || (p.r !== 'owner' && p.r !== 'cashier')) return null
  if (p.v !== undefined && p.v !== 1) return null
  if (nowSec >= p.abs) return null
  if (!opts.allowExpired && nowSec >= p.exp) return null
  return p
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null
}
