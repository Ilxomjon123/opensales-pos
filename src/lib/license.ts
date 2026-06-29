import { ref } from 'vue'
import nacl from 'tweetnacl'
import { getSetting, setSetting } from './db'
import { t } from './i18n'

// Barcha key/secret .env'da (build-time). Dasturga FAQAT public kalit joylanadi; private (seed) faqat egasida.
const PUBLIC_KEY_B64 = (import.meta.env.VITE_LICENSE_PUBKEY ?? '').trim()
const TRIAL_DAYS = Number(import.meta.env.VITE_TRIAL_DAYS ?? '15') || 15
// Yaxlitlik (tamper) maxfiyi — trial/guard checksum uchun.
const INTEGRITY_SECRET = (import.meta.env.VITE_INTEGRITY_SECRET ?? '').trim()
const DAY = 86400000
// Master kalit OCHIQ matn emas — faqat SHA-512 hash bundle'da. Kalit so'zning o'zi
// kodda yo'q → bundle'ni o'qib topib bo'lmaydi. (Hash hex, kichik harf.)
const OWNER_MASTER_HASH = (import.meta.env.VITE_OWNER_MASTER_HASH ?? '').trim().toLowerCase()

// --- base64 (binary-safe, url-agnostik) ---
function b64ToBytes(s: string): Uint8Array {
  let t = s.trim().replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4) t += '='
  const bin = atob(t)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
function bytesToB64url(u: Uint8Array): string {
  let bin = ''
  for (const b of u) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const enc = new TextEncoder()
const dec = new TextDecoder()
const PUBLIC_KEY = b64ToBytes(PUBLIC_KEY_B64)

export type LicenseMode = 'trial' | 'licensed' | 'expired'
export type LicenseInfo = { active: boolean; mode: LicenseMode; until: string | null; forever: boolean; daysLeft: number; deviceId: string }
export const license = ref<LicenseInfo>({ active: false, mode: 'expired', until: null, forever: false, daysLeft: 0, deviceId: '' })

function todayStr() { return new Date().toISOString().slice(0, 10) }

export async function getDeviceId(): Promise<string> {
  let id = await getSetting('device_id', '')
  if (!id) {
    const raw = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))
    id = raw.replace(/[^a-z0-9]/gi, '').slice(0, 16).toUpperCase()
    await setSetting('device_id', id)
  }
  return id
}
// --- Tamper-proof guard (trial sanasi + monoton vaqt) ---
type Guard = { install: string; lastSeen: number }
function guardTag(json: string): string {
  return bytesToB64url(nacl.hash(enc.encode(INTEGRITY_SECRET + '|' + json))).slice(0, 43)
}
async function saveGuard(g: Guard): Promise<void> {
  const json = JSON.stringify(g)
  await setSetting('lic_guard', bytesToB64url(enc.encode(json)) + '.' + guardTag(json))
}
async function loadGuard(): Promise<{ guard: Guard; tampered: boolean }> {
  const raw = await getSetting('lic_guard', '')
  if (raw) {
    const [p, t] = raw.split('.')
    if (p && t) {
      const json = dec.decode(b64ToBytes(p))
      if (guardTag(json) === t) {
        try { return { guard: JSON.parse(json) as Guard, tampered: false } } catch {}
      }
    }
    // Mavjud, lekin checksum mos emas → qo'lda buzilgan.
    return { guard: { install: todayStr(), lastSeen: Date.now() }, tampered: true }
  }
  // Birinchi ishga tushish — eski install_date bo'lsa undan, bo'lmasa bugundan.
  const prev = await getSetting('install_date', '')
  const g: Guard = { install: prev || todayStr(), lastSeen: Date.now() }
  await saveGuard(g)
  return { guard: g, tampered: false }
}

type Payload = { d: string; exp: string | null } // device, expiry (ISO sana yoki null=cheksiz)

export function verifyKey(key: string): Payload | null {
  try {
    const [p, s] = key.trim().split('.')
    if (!p || !s) return null
    const msg = b64ToBytes(p)
    if (!nacl.sign.detached.verify(msg, b64ToBytes(s), PUBLIC_KEY)) return null
    return JSON.parse(dec.decode(msg)) as Payload
  } catch { return null }
}

export async function refreshLicense(): Promise<LicenseInfo> {
  const deviceId = await getDeviceId()
  const { guard, tampered } = await loadGuard()

  // Monoton vaqt: soat orqaga surilsa ham vaqt oldinga yuradi. Barcha muddat shu bilan tekshiriladi.
  const effNow = Math.max(Date.now(), guard.lastSeen)
  if (effNow !== guard.lastSeen) { guard.lastSeen = effNow; await saveGuard(guard) }

  const set = (i: LicenseInfo) => (license.value = i)

  // Egasi bekor qilgan — sinov ham, eski kalit ham ishlamaydi.
  if ((await getSetting('license_revoked', '0')) === '1') {
    return set({ active: false, mode: 'expired', until: null, forever: false, daysLeft: 0, deviceId })
  }

  // Pullik kalit — imzo bilan himoyalangan, guard buzilsa ham mustaqil ishlaydi.
  const stored = await getSetting('license_key', '')
  if (stored) {
    const pl = verifyKey(stored)
    if (pl && pl.d === deviceId) {
      if (pl.exp === null) return set({ active: true, mode: 'licensed', until: null, forever: true, daysLeft: Infinity, deviceId })
      const left = Math.ceil((Date.parse(pl.exp) - effNow) / DAY)
      if (left > 0) return set({ active: true, mode: 'licensed', until: pl.exp, forever: false, daysLeft: left, deviceId })
    }
  }

  // Sinov — faqat guard buzilmagan bo'lsa. install_date qo'lda o'zgartirilsa checksum mos kelmaydi → trial yo'q.
  if (!tampered) {
    const trialLeft = TRIAL_DAYS - Math.floor((effNow - Date.parse(guard.install)) / DAY)
    if (trialLeft > 0) return set({ active: true, mode: 'trial', until: null, forever: false, daysLeft: trialLeft, deviceId })
  }

  return set({ active: false, mode: 'expired', until: null, forever: false, daysLeft: 0, deviceId })
}

export async function activate(key: string): Promise<{ ok: boolean; msg: string }> {
  const deviceId = await getDeviceId()
  const pl = verifyKey(key)
  if (!pl) return { ok: false, msg: t('activation.keyInvalid') }
  if (pl.d !== deviceId) return { ok: false, msg: t('activation.keyDeviceMismatch') }
  if (pl.exp !== null && Date.parse(pl.exp) < Date.now()) return { ok: false, msg: t('activation.keyExpired') }
  await setSetting('license_key', key.trim())
  await setSetting('license_revoked', '0') // qayta faollashtirilganda bekorni olib tashlash
  await refreshLicense()
  return { ok: true, msg: pl.exp === null ? t('activation.activatedForever') : t('activation.activatedUntil', { date: pl.exp }) }
}

// Egasi: shu qurilmada litsenziyani bekor qilish — dastur aktivatsiyani kutadi.
export async function deactivate(): Promise<void> {
  await setSetting('license_key', '')
  await setSetting('license_revoked', '1')
  await refreshLicense()
}

// ---- Egasi uchun generator (seed dasturda saqlanmaydi, qo'lda kiritiladi) ----
// SHA-512 hex (sync, nacl orqali) — master kalitni ochiq saqlamasdan tekshirish uchun.
function sha512hex(s: string): string {
  return Array.from(nacl.hash(enc.encode(s))).map((b) => b.toString(16).padStart(2, '0')).join('')
}
export function isOwnerMaster(input: string): boolean {
  return OWNER_MASTER_HASH !== '' && sha512hex(input.trim().toUpperCase()) === OWNER_MASTER_HASH
}
export function generateKey(deviceId: string, exp: string | null, secretSeedB64: string): string {
  const sk = b64ToBytes(secretSeedB64)
  if (sk.length !== 64) throw new Error(t('activation.seedInvalid'))
  const payload: Payload = { d: deviceId.trim().toUpperCase(), exp }
  const msg = enc.encode(JSON.stringify(payload))
  const sig = nacl.sign.detached(msg, sk)
  return bytesToB64url(msg) + '.' + bytesToB64url(sig)
}
