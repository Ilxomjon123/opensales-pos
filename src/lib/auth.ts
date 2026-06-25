import { ref } from 'vue'
import { getSetting, setSetting } from './db'

export const isAuthed = ref<boolean>(sessionStorage.getItem('authed') === '1')

// PIN unutilganda maxsus kalit so'z bilan qayta o'rnatish.
export async function verifyRecoveryKey(recoveryKey: string): Promise<boolean> {
  // Faqat .env dagi master kalit (build-time). DB'da saqlanmaydi.
  const master = (import.meta.env.VITE_RECOVERY_MASTER ?? '').trim().toUpperCase()
  return master !== '' && recoveryKey.trim().toUpperCase() === master
}
export async function setPin(newPin: string): Promise<void> {
  if (!/^\d{4}$/.test(newPin)) throw new Error('PIN 4 raqam bo\'lishi kerak')
  await setSetting('auth_pin', newPin)
}

export async function loginPin(pin: string): Promise<boolean> {
  const real = await getSetting('auth_pin', (import.meta.env.VITE_DEFAULT_PIN ?? '1234') as string)
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
