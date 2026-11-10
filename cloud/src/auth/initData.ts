// Telegram Mini App initData tekshiruvi (https://core.telegram.org/bots/webapps).
//
// secret = HMAC_SHA256(key = "WebAppData", msg = bot_token)
// hash   = hex(HMAC_SHA256(key = secret, msg = data_check_string))
// data_check_string — `hash` dan boshqa barcha maydonlar (signature ham) `k=v`, alifbo
// tartibida, "\n" bilan. backend/app/Support/Telegram/InitDataHash.php bilan bir xil.

export type TgUser = {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
}

export type VerifiedInitData = {
  user: TgUser
  authDate: number
  startParam: string | null
}

/** Replay himoyasi: initData'ning eng katta yoshi (soniya). */
export const INIT_DATA_MAX_AGE = 86400

const enc = new TextEncoder()

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(msg))
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

function decode(v: string): string {
  try { return decodeURIComponent(v.replace(/\+/g, ' ')) } catch { return v }
}

function pairs(raw: string): [string, string][] {
  const out: [string, string][] = []
  for (const part of raw.split('&')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    out.push([part.slice(0, i), decode(part.slice(i + 1))])
  }
  return out
}

function dataCheckString(entries: [string, string][]): string {
  return entries.filter(([k]) => k !== 'hash').map(([k, v]) => `${k}=${v}`).sort().join('\n')
}

/** To'g'ri bo'lsa foydalanuvchi va start_param; aks holda null (sababini oshkor qilmaydi). */
export async function verifyInitData(raw: string, botToken: string, nowSec: number, maxAge = INIT_DATA_MAX_AGE): Promise<VerifiedInitData | null> {
  if (!raw || raw.length > 8192 || !botToken) return null
  const entries = pairs(raw)
  const get = (k: string) => entries.find(([key]) => key === k)?.[1]
  const hash = hexToBytes(get('hash') ?? '')
  const authDate = Number(get('auth_date'))
  const userJson = get('user')
  if (!hash || !Number.isInteger(authDate) || !userJson) return null
  if (nowSec - authDate > maxAge || authDate - nowSec > 300) return null

  const secret = await hmac(enc.encode('WebAppData'), botToken)
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  // verify() — vaqt bo'yicha xavfsiz taqqoslash.
  const ok = await crypto.subtle.verify('HMAC', key, hash, enc.encode(dataCheckString(entries)))
  if (!ok) return null

  let user: TgUser
  try { user = JSON.parse(userJson) } catch { return null }
  if (!user || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return null
  return { user, authDate, startParam: get('start_param') ?? null }
}

/**
 * Imzolangan initData yasaydi — FAQAT testlar va lokal dev shim uchun (Worker'dan chaqirilmaydi).
 * Bot token haqiqiy Telegram'nikidek ishlaydi, shuning uchun prod tokeni bilan ishlatilmasin.
 */
export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const entries = Object.entries(fields)
  const secret = await hmac(enc.encode('WebAppData'), botToken)
  const hash = toHex(await hmac(secret, dataCheckString(entries)))
  return [...entries, ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
}

/** Ko'rinadigan ism: "Ism Familiya" yoki @username yoki id. */
export function displayName(u: TgUser): string {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return (full || (u.username ? '@' + u.username : String(u.id))).slice(0, 120)
}
