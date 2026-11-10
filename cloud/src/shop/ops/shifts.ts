import { DomainError, forbidden } from '../errors'
import type { Ctx, OpTable } from '../rpc'
import * as v from '../v'

// Smena — src/lib/db.ts porti. Farq: desktop'da bitta kassa = bitta smena; bulutda har
// xodimning o'z smenasi (`user_id`), har kim faqat o'zinikini ko'radi/yopadi, egasi
// hammasini (ro'yxat va yopish).

type Shift = { id: number; opened_at: string; closed_at: string | null; opening_cash: number; closing_cash: number | null; status: string; user_id: number | null }

/** Joriy xodimning ochiq smenasi. */
export function ownOpenShift(ctx: Ctx): Shift | null {
  return ctx.sql.get<Shift>("SELECT * FROM shifts WHERE status = 'open' AND user_id = ? ORDER BY id DESC LIMIT 1", ctx.actor.uid) ?? null
}

/** Smenani ko'rish huquqi: o'ziniki yoki egasi. Topilmasa/begona bo'lsa xato. */
export function accessibleShift(ctx: Ctx, shiftId: number): Shift {
  const s = ctx.sql.get<Shift>('SELECT * FROM shifts WHERE id = ?', shiftId)
  if (!s) throw new DomainError('cloud.errors.notFound', { what: 'shift' }, 404)
  if (ctx.actor.role !== 'owner' && s.user_id !== ctx.actor.uid) throw forbidden()
  return s
}

export function shiftStats(ctx: Ctx, shiftId: number) {
  const s = ctx.sql.get<{ sales_count: number; total_sales: number; total_cash: number; total_card: number; total_debt: number }>(
    `SELECT COUNT(*) sales_count, COALESCE(SUM(total),0) total_sales,
            COALESCE(SUM(paid_cash),0) total_cash, COALESCE(SUM(paid_card),0) total_card,
            COALESCE(SUM(debt_amount),0) total_debt
     FROM sales WHERE shift_id = ?`,
    shiftId,
  )!
  // Vozvrat sotuvning smenasiga emas, qaytarilgan paytdagi smenaga yoziladi.
  const ret = ctx.sql.get<{ c: number; total: number; cash: number; card: number }>(
    `SELECT COUNT(*) c, COALESCE(SUM(amount),0) total, COALESCE(SUM(refund_cash),0) cash, COALESCE(SUM(refund_card),0) card
     FROM sale_returns WHERE shift_id = ?`,
    shiftId,
  ) ?? { c: 0, total: 0, cash: 0, card: 0 }
  const sh = ctx.sql.get<{ opening_cash: number }>('SELECT opening_cash FROM shifts WHERE id = ?', shiftId)
  return {
    sales_count: s.sales_count,
    total_sales: s.total_sales,
    total_cash: s.total_cash,
    total_card: s.total_card,
    total_debt: s.total_debt,
    returns_count: ret.c,
    returns_total: ret.total,
    refund_cash: ret.cash,
    refund_card: ret.card,
    expected_cash: (sh?.opening_cash ?? 0) + s.total_cash - ret.cash,
  }
}

export const shiftOps: OpTable = {
  activeShift: {
    access: 'cashier',
    write: false,
    run: (ctx) => ownOpenShift(ctx),
  },
  // Ochiq smena bo'lsa yangisi ochilmaydi — o'sha qaytadi (ikki marta bosish xavfsiz).
  openShift: {
    access: 'cashier',
    write: true,
    run(ctx, raw) {
      const openingCash = Math.max(0, v.money(v.args(raw)[0] ?? 0, 'openingCash'))
      const existing = ownOpenShift(ctx)
      if (existing) return existing
      ctx.sql.run("INSERT INTO shifts(opened_at, opening_cash, status, user_id) VALUES(?, ?, 'open', ?)", ctx.now(), openingCash, ctx.actor.uid)
      return ownOpenShift(ctx)
    },
  },
  closeShift: {
    access: 'cashier',
    write: true,
    allowExpired: true,
    run(ctx, raw) {
      const [idRaw, cashRaw] = v.args(raw)
      const shift = accessibleShift(ctx, v.id(idRaw, 'shiftId'))
      const closingCash = Math.max(0, v.money(cashRaw ?? 0, 'closingCash'))
      if (shift.status !== 'open') return null
      ctx.sql.run("UPDATE shifts SET status='closed', closed_at=?, closing_cash=? WHERE id=?", ctx.now(), closingCash, shift.id)
      return null
    },
  },
  shiftStats: {
    access: 'cashier',
    write: false,
    run(ctx, raw) {
      const shift = accessibleShift(ctx, v.id(v.args(raw)[0], 'shiftId'))
      return shiftStats(ctx, shift.id)
    },
  },
  // Ro'yxat (oxirgi 200) + kim ochgani (`user_name`).
  listShifts: {
    access: 'owner',
    write: false,
    run: (ctx) => ctx.sql.all(
      `SELECT sh.*,
              (SELECT COUNT(*) FROM sales s WHERE s.shift_id = sh.id) sales_count,
              (SELECT COALESCE(SUM(s.total),0) FROM sales s WHERE s.shift_id = sh.id) total_sales,
              (SELECT COALESCE(SUM(r.amount),0) FROM sale_returns r WHERE r.shift_id = sh.id) returns_total,
              m.name user_name
       FROM shifts sh LEFT JOIN members m ON m.uid = sh.user_id
       ORDER BY sh.id DESC LIMIT 200`,
    ),
  },
}
