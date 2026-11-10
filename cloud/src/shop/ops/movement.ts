import type { Ctx, OpTable } from '../rpc'
import { jsonList } from '../sql'
import * as v from '../v'

// Kirimlar ro'yxati va tovar harakati hisobotlari — src/lib/stock.ts porti (SQL so'zma-so'z).

const RECEIPT_STATUS_SQL = {
  active: 'r.voided_at IS NULL',
  voided: 'r.voided_at IS NOT NULL',
} as const

// Qoldiqni o'zgartiradigan to'rt jurnal bitta ro'yxatda (src/lib/stock.ts izohi).
export const MOVES_SQL = `
  SELECT 'receipt' kind, ri.product_id pid, r.id doc_id, ri.id line_id, r.receipt_number number,
         r.received_at at, r.supplier supplier, NULL customer_id, r.note comment,
         ri.qty delta, ri.cost_price price, ri.subtotal amount
  FROM stock_receipt_items ri JOIN stock_receipts r ON r.id = ri.receipt_id WHERE r.voided_at IS NULL
  UNION ALL
  SELECT 'sale', si.product_id, s.id, si.id, s.receipt_number, s.created_at, NULL, s.customer_id, s.note,
         -si.qty, si.price, si.subtotal
  FROM sale_items si JOIN sales s ON s.id = si.sale_id
  UNION ALL
  SELECT 'return', ri.product_id, r.id, ri.id, r.return_number, r.created_at, NULL, r.customer_id, r.reason,
         ri.qty, ri.price, ri.subtotal
  FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
  UNION ALL
  SELECT 'adjust', a.product_id, a.id, a.id, 'T-' || printf('%05d', a.id), a.created_at, NULL, NULL, a.note,
         a.delta, NULL, NULL
  FROM stock_adjustments a`

const q3 = (n: number) => Math.round(n * 1000) / 1000

type StockReceipt = Record<string, unknown> & { id: number }
type StockReceiptItem = Record<string, unknown> & { receipt_id: number }

function listStockReceipts(ctx: Ctx, raw: unknown) {
  const f = v.optObj(v.args(raw)[0], 'filter')
  const where: string[] = []
  const args: (string | number)[] = []
  const productId = v.optId(f.productId, 'productId')
  if (productId) { where.push('EXISTS (SELECT 1 FROM stock_receipt_items i WHERE i.receipt_id = r.id AND i.product_id = ?)'); args.push(productId) }
  const from = v.optDay(f.dateFrom, 'dateFrom')
  if (from) { where.push('date(r.received_at) >= date(?)'); args.push(from) }
  const to = v.optDay(f.dateTo, 'dateTo')
  if (to) { where.push('date(r.received_at) <= date(?)'); args.push(to) }
  const status = v.optOneOf(f.status, 'status', ['active', 'voided'] as const)
  if (status) where.push(RECEIPT_STATUS_SQL[status])
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const rows = ctx.sql.all<StockReceipt>(`SELECT r.* FROM stock_receipts r ${w} ORDER BY r.received_at DESC, r.id DESC LIMIT 1000`, ...args)
  const byReceipt = new Map<number, StockReceiptItem[]>()
  if (rows.length) {
    const items = ctx.sql.all<StockReceiptItem>(
      `SELECT id, receipt_id, product_id, product_name, unit, qty, cost_price, subtotal, sale_price
       FROM stock_receipt_items WHERE receipt_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
      jsonList(rows.map((r) => r.id)),
    )
    for (const it of items) byReceipt.set(it.receipt_id, [...(byReceipt.get(it.receipt_id) ?? []), it])
  }
  return rows.map((r) => ({ ...r, items: byReceipt.get(r.id) ?? [] }))
}

function stockMovementReport(ctx: Ctx, raw: unknown) {
  const [f, t] = v.args(raw)
  const rows = ctx.sql.all<Record<string, unknown> & { stock: number; after_net: number; moves: number; income: number; outcome: number }>(
    `WITH prm AS (SELECT date(?) f, date(?) t), mv AS (${MOVES_SQL})
     SELECT p.id product_id, p.name, p.unit, c.name category, p.is_active, p.cost_price, p.stock,
       COALESCE(SUM(CASE WHEN date(mv.at) > prm.t THEN mv.delta END), 0) after_net,
       COALESCE(SUM(CASE WHEN date(mv.at) BETWEEN prm.f AND prm.t AND mv.delta > 0 THEN mv.delta END), 0) income,
       COALESCE(SUM(CASE WHEN date(mv.at) BETWEEN prm.f AND prm.t AND mv.delta < 0 THEN -mv.delta END), 0) outcome,
       COUNT(CASE WHEN date(mv.at) BETWEEN prm.f AND prm.t THEN 1 END) moves
     FROM products p CROSS JOIN prm
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN mv ON mv.pid = p.id
     GROUP BY p.id
     ORDER BY p.name`,
    v.day(f, 'dateFrom'), v.day(t, 'dateTo'),
  )
  return rows
    .map(({ stock, after_net, moves, ...r }) => {
      const closing = q3(stock - after_net)
      return { ...r, income: q3(r.income), outcome: q3(r.outcome), opening: q3(closing - r.income + r.outcome), closing, moves }
    })
    .filter((r) => r.closing !== 0 || r.moves > 0)
    .map(({ moves: _, ...r }) => r)
}

type MoveRow = {
  kind: string; doc_id: number; line_id: number; number: string; at: string; day: string; supplier: string | null
  customer_id: number | null; comment: string | null; delta: number; price: number | null; amount: number | null
  run: number; customer_name: string | null; is_walk_in: number | null
}

function productMoves(ctx: Ctx, raw: unknown) {
  const [pid, label] = v.args(raw)
  const productId = v.id(pid, 'productId')
  const walkInLabel = v.str(label ?? '', 'walkInLabel', 100)
  const rows = ctx.sql.all<MoveRow>(
    `WITH mv AS (${MOVES_SQL}),
     ord AS (
       SELECT mv.*, date(mv.at) day,
              SUM(mv.delta) OVER (ORDER BY date(mv.at), (mv.delta < 0), mv.at, mv.kind, mv.line_id ROWS UNBOUNDED PRECEDING) run,
              ROW_NUMBER() OVER (ORDER BY date(mv.at), (mv.delta < 0), mv.at, mv.kind, mv.line_id) seq
       FROM mv WHERE mv.pid = ?
     )
     SELECT ord.kind, ord.doc_id, ord.line_id, ord.number, ord.at, ord.day, ord.supplier, ord.customer_id, ord.comment,
            ord.delta, ord.price, ord.amount, ord.run, c.name customer_name, c.is_walk_in
     FROM ord LEFT JOIN customers c ON c.id = ord.customer_id
     ORDER BY ord.seq`,
    productId,
  )
  const p = ctx.sql.get<{ stock: number }>('SELECT stock FROM products WHERE id = ?', productId)
  const total = rows.length ? rows[rows.length - 1].run : 0
  const offset = (p?.stock ?? 0) - total
  return rows.map((r) => {
    const supplier = r.supplier?.trim() || null
    const party = r.kind === 'receipt' ? supplier : r.customer_id ? (r.is_walk_in ? walkInLabel : r.customer_name) : null
    const party_key = r.kind === 'receipt' ? (supplier ? `s:${supplier}` : null) : r.customer_id ? `c:${r.customer_id}` : null
    return {
      key: `${r.kind}:${r.line_id}`,
      kind: r.kind,
      doc_id: r.doc_id,
      number: r.number,
      at: r.at,
      day: r.day,
      party,
      party_key,
      comment: r.comment?.trim() || null,
      delta: q3(r.delta),
      price: r.price,
      amount: r.amount,
      balance: q3(offset + r.run),
    }
  })
}

export const movementOps: OpTable = {
  listStockReceipts: { access: 'owner', write: false, run: listStockReceipts },
  receiptSuppliers: {
    access: 'owner',
    write: false,
    run: (ctx) => ctx.sql.all<{ supplier: string }>(
      'SELECT supplier FROM stock_receipts WHERE supplier IS NOT NULL GROUP BY supplier ORDER BY MAX(id) DESC LIMIT 50',
    ).map((x) => x.supplier),
  },
  stockMovementReport: { access: 'owner', write: false, run: stockMovementReport },
  productMoves: { access: 'owner', write: false, run: productMoves },
}
