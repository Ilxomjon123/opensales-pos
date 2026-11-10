import { computed } from 'vue'
import { session } from '../session'
import type { Permission } from '../../../src/lib/auth'

// Desktop auth.ts (PIN) o'rniga — Telegram sessiyasi va rol. Huquq server tomonda ham
// tekshiriladi; bu yerda faqat UI'da ko'rsatmaslik uchun.
export type { Permission }

export const isAuthed = computed(() => session.status === 'ok')

const OWNER_ONLY_PERMS: Permission[] = ['editPrice', 'returns', 'debtPayment']

export function can(perm: Permission): boolean {
  // Admin ko'rish rejimi — tahrir/sotuv tugmalari yashirin (server baribir rad etadi).
  if (session.view) return false
  // Filial: tovar, narx, kategoriya asosiy do'konda o'zgartiriladi (server ham rad etadi).
  if (perm === 'catalogEdit') return session.user?.role === 'owner' && !session.shop?.catalogOf
  if (session.user?.role === 'owner') return true
  if (perm === 'discount') return session.settings.cashier_discount === '1'
  return !OWNER_ONLY_PERMS.includes(perm)
}

/** Kassir ko'radigan bo'limlar. */
const CASHIER_ROUTES = ['/pos', '/sales', '/settings']

export function routeAllowed(path: string): boolean {
  // Sessiya hali yo'q (ilova endi ochilmoqda) — Gate ko'rinadi; rol aniq bo'lgach
  // main.ts joriy sahifani qayta tekshiradi.
  if (!session.user) return true
  // Admin bo'limi rolga emas, platforma adminiga bog'liq.
  if (path === '/admin' || path.startsWith('/admin?')) return session.admin && !session.view
  // Ko'rish rejimida server ularni rad etadi (xodimlar, ko'chirish, umumiy hisobot).
  if (session.view && ['/staff', '/transfers', '/business'].some((r) => path === r || path.startsWith(r + '/'))) return false
  if (session.user.role === 'owner') return true
  return CASHIER_ROUTES.some((r) => path === r || path.startsWith(r + '/') || path.startsWith(r + '?'))
}

export function logout() { /* Telegram ichida chiqish yo'q — oyna yopiladi */ }
