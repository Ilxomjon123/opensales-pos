import { forbidden } from '../errors'
import type { OpTable } from '../rpc'
import * as v from '../v'

// Sozlamalar. Desktop'dagi kalitlarning faqat bulutda ma'nosi borlari ochiq; PIN, litsenziya,
// qurilma, zaxira, printer kalitlari bu yerda YO'Q (o'qilsa fallback, yozilsa 403).

/** Kassir ham o'qiydi (kassa ishlashi uchun kerak). */
export const PUBLIC_SETTINGS = ['currency_symbol', 'shop_name', 'allow_negative_stock', 'keep_cart', 'cashier_discount'] as const
/** Faqat egasi yozadi. */
export const WRITABLE_SETTINGS = [...PUBLIC_SETTINGS] as const

const isPublic = (k: string) => (PUBLIC_SETTINGS as readonly string[]).includes(k)
const isWritable = (k: string) => (WRITABLE_SETTINGS as readonly string[]).includes(k)

export const settingsOps: OpTable = {
  getSetting: {
    access: 'cashier',
    write: false,
    run(ctx, raw) {
      const [key, fallback] = v.args(raw)
      const k = v.str(key, 'key', 64)
      const fb = fallback === undefined ? '' : v.str(fallback, 'fallback', 1000)
      if (!isPublic(k)) return fb
      return ctx.setting(k, fb)
    },
  },
  setSetting: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const [key, value] = v.args(raw)
      const k = v.str(key, 'key', 64)
      const val = v.str(value, 'value', 200)
      if (!isWritable(k)) throw forbidden()
      ctx.sql.run(
        'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        k, val,
      )
      return null
    },
  },
}
