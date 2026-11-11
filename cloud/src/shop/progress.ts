import type { OpTable } from './rpc'
import type { Sql } from './sql'

// Do'konning boshlang'ich holati (varonka): tovar bormi, sotuv bormi, keyingi kunda qaytib sotdimi.
// Ilovadagi "Boshlash" kartasi, birinchi smenani avtomatik ochish va admin varonkasi shundan o'qiydi.

export type ShopProgress = {
  products: number
  sales: number
  shifts: number
  firstSaleAt: string | null
  lastSaleAt: string | null
  /** Birinchi sotuv kunidan (Toshkent, UTC+5) KEYINGI biror kundagi birinchi sotuv. */
  day2At: string | null
}

export function shopProgress(sql: Sql): ShopProgress {
  const products = sql.get<{ n: number }>('SELECT COUNT(*) n FROM products WHERE is_active = 1')?.n ?? 0
  const s = sql.get<{ n: number; first: string | null; last: string | null }>('SELECT COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM sales')
  const shifts = sql.get<{ n: number }>('SELECT COUNT(*) n FROM shifts')?.n ?? 0
  const first = s?.first ?? null
  const day2At = first
    ? sql.get<{ at: string | null }>("SELECT MIN(created_at) at FROM sales WHERE date(created_at, '+5 hours') > date(?, '+5 hours')", first)?.at ?? null
    : null
  return { products, sales: s?.n ?? 0, shifts, firstSaleAt: first, lastSaleAt: s?.last ?? null, day2At }
}

export const progressOps: OpTable = {
  shopProgress: { access: 'cashier', write: false, run: (ctx) => shopProgress(ctx.sql) },
}
