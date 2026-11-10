import { db } from './db'

// Hisobot sahifasining so'rovlari (ilgari Reports.vue ichida edi). SQL so'zma-so'z
// ko'chirilgan — Telegram mini app ham shu nomdagi funksiyalarni serverdan oladi.

export type ReportPeriod = {
  count: number
  /** Davrdagi sotuvlar (vozvratsiz). */
  gross: number
  /** Qolganlari — vozvratlar ayirilgandan keyin (sof). */
  total: number
  cash: number
  card: number
  debt: number
  returns: number
  profit: number
}
export type ReportTopProduct = { name: string; qty: number; total: number }
export type ReportLowStock = { name: string; stock: number; unit: string }
export type ReportSummary = { period: ReportPeriod; topProducts: ReportTopProduct[]; lowStock: ReportLowStock[] }

// Ilk sotuv kuni (YYYY-MM-DD) yoki null — "Hammasi" preseti uchun.
export async function firstSaleDate(): Promise<string | null> {
  const d = await db()
  const r = await d.select<{ first: string | null }[]>("SELECT date(MIN(created_at)) first FROM sales")
  return r[0]?.first ?? null
}

export async function reportSummary(from: string, to: string): Promise<ReportSummary> {
  const d = await db()
  const t = await d.select<any[]>(
    `SELECT COUNT(*) count, COALESCE(SUM(total),0) total, COALESCE(SUM(paid_cash),0) cash,
            COALESCE(SUM(paid_card),0) card, COALESCE(SUM(debt_amount),0) debt
     FROM sales WHERE date(created_at) BETWEEN ? AND ?`, [from, to],
  )
  const p = await d.select<any[]>(
    // Tannarx sotuvda muzlatiladi (si.cost_price). Eski sotuvlarda u 0 — o'shanda joriy
    // mahsulot tannarxiga qaytamiz (eski hisobotlar buzilmasin).
    `SELECT COALESCE(SUM((si.price - COALESCE(NULLIF(si.cost_price,0), pr.cost_price, 0)) * si.qty),0) profit
     FROM sale_items si LEFT JOIN products pr ON pr.id = si.product_id
     JOIN sales s ON s.id = si.sale_id
     WHERE date(s.created_at) BETWEEN ? AND ?`, [from, to],
  )
  // Vozvrat qaytarilgan KUNI hisoblanadi (pul o'sha kuni chiqqan). Foyda sotuvdagi formulaning
  // aynan teskarisi — to'liq qaytgan sotuv hisobotda nol foyda beradi.
  const r = await d.select<{ amount: number; cash: number; card: number }[]>(
    `SELECT COALESCE(SUM(amount),0) amount, COALESCE(SUM(refund_cash),0) cash, COALESCE(SUM(refund_card),0) card
     FROM sale_returns WHERE date(created_at) BETWEEN ? AND ?`, [from, to],
  )
  const rp = await d.select<{ profit: number }[]>(
    `SELECT COALESCE(SUM((ri.price - COALESCE(NULLIF(ri.cost_price,0), pr.cost_price, 0)) * ri.qty),0) profit
     FROM sale_return_items ri LEFT JOIN products pr ON pr.id = ri.product_id
     JOIN sale_returns r ON r.id = ri.return_id
     WHERE date(r.created_at) BETWEEN ? AND ?`, [from, to],
  )
  const ret = r[0] ?? { amount: 0, cash: 0, card: 0 }
  const s = t[0]
  const period: ReportPeriod = {
    count: s.count, gross: s.total, total: s.total - ret.amount, cash: s.cash - ret.cash, card: s.card - ret.card,
    debt: s.debt, returns: ret.amount, profit: (p[0]?.profit ?? 0) - (rp[0]?.profit ?? 0),
  }
  // Sof sotuv: sotilgan − qaytarilgan (davr ichida). To'liq qaytganlar ro'yxatga chiqmaydi.
  const topProducts = await d.select<ReportTopProduct[]>(
    `SELECT name, SUM(qty) qty, SUM(total) total FROM (
       SELECT si.product_name name, si.qty qty, si.subtotal total
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE date(s.created_at) BETWEEN ? AND ?
       UNION ALL
       SELECT ri.product_name, -ri.qty, -ri.subtotal
       FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
       WHERE date(r.created_at) BETWEEN ? AND ?
     ) GROUP BY name HAVING SUM(qty) > 0.000001 ORDER BY total DESC LIMIT 8`, [from, to, from, to],
  )
  const lowStock = await d.select<ReportLowStock[]>(
    `SELECT name, stock, unit FROM products WHERE is_active = 1 AND stock <= 10 ORDER BY stock LIMIT 10`,
  )
  return { period, topProducts, lowStock }
}
