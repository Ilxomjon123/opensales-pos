import type { OpTable } from '../rpc'
import * as v from '../v'

// Hisobot — src/lib/reports.ts porti (SQL so'zma-so'z).

export const reportOps: OpTable = {
  firstSaleDate: {
    access: 'owner',
    write: false,
    run: (ctx) => ctx.sql.get<{ first: string | null }>('SELECT date(MIN(created_at)) first FROM sales')?.first ?? null,
  },
  reportSummary: {
    access: 'owner',
    write: false,
    run(ctx, raw) {
      const [f, t] = v.args(raw)
      const from = v.day(f, 'dateFrom'), to = v.day(t, 'dateTo')
      const s = ctx.sql.get<{ count: number; total: number; cash: number; card: number; debt: number }>(
        `SELECT COUNT(*) count, COALESCE(SUM(total),0) total, COALESCE(SUM(paid_cash),0) cash,
                COALESCE(SUM(paid_card),0) card, COALESCE(SUM(debt_amount),0) debt
         FROM sales WHERE date(created_at) BETWEEN ? AND ?`, from, to,
      )!
      const p = ctx.sql.get<{ profit: number }>(
        `SELECT COALESCE(SUM((si.price - COALESCE(NULLIF(si.cost_price,0), pr.cost_price, 0)) * si.qty),0) profit
         FROM sale_items si LEFT JOIN products pr ON pr.id = si.product_id
         JOIN sales s ON s.id = si.sale_id
         WHERE date(s.created_at) BETWEEN ? AND ?`, from, to,
      )
      const ret = ctx.sql.get<{ amount: number; cash: number; card: number }>(
        `SELECT COALESCE(SUM(amount),0) amount, COALESCE(SUM(refund_cash),0) cash, COALESCE(SUM(refund_card),0) card
         FROM sale_returns WHERE date(created_at) BETWEEN ? AND ?`, from, to,
      ) ?? { amount: 0, cash: 0, card: 0 }
      const rp = ctx.sql.get<{ profit: number }>(
        `SELECT COALESCE(SUM((ri.price - COALESCE(NULLIF(ri.cost_price,0), pr.cost_price, 0)) * ri.qty),0) profit
         FROM sale_return_items ri LEFT JOIN products pr ON pr.id = ri.product_id
         JOIN sale_returns r ON r.id = ri.return_id
         WHERE date(r.created_at) BETWEEN ? AND ?`, from, to,
      )
      const period = {
        count: s.count, gross: s.total, total: s.total - ret.amount, cash: s.cash - ret.cash, card: s.card - ret.card,
        debt: s.debt, returns: ret.amount, profit: (p?.profit ?? 0) - (rp?.profit ?? 0),
      }
      const topProducts = ctx.sql.all(
        `SELECT name, SUM(qty) qty, SUM(total) total FROM (
           SELECT si.product_name name, si.qty qty, si.subtotal total
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
           WHERE date(s.created_at) BETWEEN ? AND ?
           UNION ALL
           SELECT ri.product_name, -ri.qty, -ri.subtotal
           FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
           WHERE date(r.created_at) BETWEEN ? AND ?
         ) GROUP BY name HAVING SUM(qty) > 0.000001 ORDER BY total DESC LIMIT 8`, from, to, from, to,
      )
      const lowStock = ctx.sql.all(
        'SELECT name, stock, unit FROM products WHERE is_active = 1 AND stock <= 10 ORDER BY stock LIMIT 10',
      )
      return { period, topProducts, lowStock }
    },
  },
  // Umumiy (biznes) hisobot uchun bitta do'kon kesimi (2026-11-09): davr savdosi/foydasi (reportSummary bilan
  // bir xil formula), xarajat, mijozlar qarzi (hozir), ombor qiymati tannarxda va sotuv narxida (hozir).
  businessSummary: {
    access: 'owner',
    write: false,
    run(ctx, raw) {
      const [f, t] = v.args(raw)
      const { period } = reportOps.reportSummary.run(ctx, [f, t]) as { period: Record<string, number> }
      const from = v.day(f, 'dateFrom'), to = v.day(t, 'dateTo')
      const expenses = ctx.sql.get<{ s: number }>('SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE date(created_at) BETWEEN ? AND ?', from, to)?.s ?? 0
      const cust = ctx.sql.get<{ owed: number; debtors: number; advance: number }>(
        `SELECT COALESCE(SUM(CASE WHEN balance < 0 THEN -balance END),0) owed, COUNT(CASE WHEN balance < 0 THEN 1 END) debtors,
                COALESCE(SUM(CASE WHEN balance > 0 THEN balance END),0) advance
         FROM customers WHERE is_active = 1 AND is_walk_in = 0`,
      )!
      const stock = ctx.sql.get<{ cost: number; retail: number; n: number }>(
        `SELECT COALESCE(SUM(CASE WHEN stock > 0 THEN stock * cost_price END),0) cost, COALESCE(SUM(CASE WHEN stock > 0 THEN stock * price END),0) retail,
                COUNT(*) n FROM products WHERE is_active = 1`,
      )!
      return {
        ...period, expenses, net: period.profit - expenses,
        receivable: cust.owed, debtors: cust.debtors, advance: cust.advance,
        stockCost: Math.round(stock.cost), stockRetail: Math.round(stock.retail), products: stock.n,
      }
    },
  },
}
