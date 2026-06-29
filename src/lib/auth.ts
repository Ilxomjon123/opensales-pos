import { ref } from 'vue'
import nacl from 'tweetnacl'
import { getSetting, setSetting } from './db'
import { t } from './i18n'

export const isAuthed = ref<boolean>(sessionStorage.getItem('authed') === '1')

// Boshlang'ich PIN — .env'da VITE_DEFAULT_PIN bo'lmasa '1234'. Yangi o'rnatishda
// auth_pin shu qiymatga seed qilinadi (db.ts seedIfEmpty).
export const defaultPin = (import.meta.env.VITE_DEFAULT_PIN ?? '1234') as string

// Joriy PIN hali boshlang'ich (o'zgartirilmagan) bo'lsa true — login sahifasida
// foydalanuvchiga maslahat ko'rsatish uchun.
export async function isDefaultPin(): Promise<boolean> {
  const pin = await getSetting('auth_pin', defaultPin)
  return pin === defaultPin
}

// SHA-512 hex (sync) — kalit so'zni ochiq saqlamaslik uchun.
function sha512hex(s: string): string {
  return Array.from(nacl.hash(new TextEncoder().encode(s))).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// PIN unutilganda owner master kalit bilan qayta o'rnatish.
// BITTA kalit — owner master (VITE_OWNER_MASTER_HASH) hamma joyda ishlaydi.
export async function verifyRecoveryKey(recoveryKey: string): Promise<boolean> {
  const hash = (import.meta.env.VITE_OWNER_MASTER_HASH ?? '').trim().toLowerCase()
  return hash !== '' && sha512hex(recoveryKey.trim().toUpperCase()) === hash
}
export async function setPin(newPin: string): Promise<void> {
  if (!/^\d{4}$/.test(newPin)) throw new Error(t('login.pinMustBe4Digits'))
  await setSetting('auth_pin', newPin)
}

export async function loginPin(pin: string): Promise<boolean> {
  const real = await getSetting('auth_pin', defaultPin)
  if (pin === real) {
    isAuthed.value = true
    sessionStorage.setItem('authed', '1')
    return true
  }
  return false
}

export function logout() {
  isAuthed.value = false
  sessionStorage.removeItem('authed')
}
