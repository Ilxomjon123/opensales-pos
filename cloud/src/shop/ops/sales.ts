import { DomainError, invalid } from '../errors'
import type { Ctx, OpTable } from '../rpc'
import { jsonList } from '../sql'
import * as v from '../v'
import { normalizeQty, QTY_EPS } from '../money'
import { ownOpenShift } from './shifts'

// Sotuv va sotuvlar tarixi — src/lib/db.ts porti.
//
// createSale desktop'dan farqi (bulutda bir nechta qurilma/kassir bor):
// - bitta tranzaksiya (dispetcher) — yarim yozilgan chek bo'lmaydi;
// - nom, birlik, tannarx klientdan EMAS, bazadan; kassir narxni o'zgartira olmaydi,
//   chegirma faqat egasi ruxsat bersa (`cashier_discount`);
// - `allow_negative_stock` o'chiq bo'lsa qoldiq serverda tekshiriladi;
// - smena — chaqiruvchining o'z ochiq smenasi.

type Sale = Record<string, unknown> & { id: number }
type ProductRow = { id: number; name: string; unit: string; price: number; cost_price: number; stock: number; is_active: number }
type CustomerRow = { id: number; is_walk_in: number }

const MAX_LINES = 500

function nextReceiptNumber(ctx: Ctx, shiftId: number): string {
  const r = ctx.sql.get<{ c: number }>('SELECT COUNT(*) c FROM sales WHERE shift_id = ?', shiftId)
  const n = (r?.c ?? 0) + 1
  return `${shiftId}-${String(n).padStart(5, '0')}`
}

function createSale(ctx: Ctx, raw: unknown): Sale {
  const input = v.obj(v.args(raw)[0], 'input')
  const shiftId = v.id(input.shiftId, 'shiftId')
  const customerId = v.id(input.customerId, 'customerId')
  const lines = v.arr(input.items, 'items', MAX_LINES)
  if (lines.length === 0) throw invalid('items')
  const paidCash = Math.max(0, v.money(input.paidCash ?? 0, 'paidCash'))
  const paidCard = Math.max(0, v.money(input.paidCard ?? 0, 'paidCard'))
  const discountIn = v.money(input.discount ?? 0, 'discount')
  const note = v.optStr(input.note, 'note', 500)

  const shift = ownOpenShift(ctx)
  if (!shift || shift.id !== shiftId) throw new DomainError('cloud.errors.shiftNotOpen', {}, 409)

  const cust = ctx.sql.get<CustomerRow>('SELECT id, is_walk_in FROM customers WHERE id = ?', customerId)
  if (!cust) throw new DomainError('sales.customerNotFound', {}, 404)

  const isOwner = ctx.actor.role === 'owner'
  const allowNegative = ctx.setting('allow_negative_stock', '0') === '1'
  const items: { p: ProductRow; price: number; qty: number }[] = []
  const wanted = new Map<number, number>()
  for (const [i, raw] of lines.entries()) {
    const l = v.obj(raw, `items.${i}`)
    const productId = v.id(l.product_id, `items.${i}.product_id`)
    const qty = normalizeQty(v.num(l.qty, `items.${i}.qty`, { min: 0, max: 1e9 }))
    if (qty <= 0) throw invalid(`items.${i}.qty`)
    const p = ctx.sql.get<ProductRow>('SELECT id, name, unit, price, cost_price, stock, is_active FROM products WHERE id = ?', productId)
    if (!p) throw new DomainError('cloud.errors.productGone', {}, 409)
    const price = v.money(l.price ?? p.price, `items.${i}.price`, { min: 0 })
    // Kassir narxni o'zgartira olmaydi (desktop'da qo'lda narx — egasining ishi).
    if (!isOwner && price !== Math.round(p.price)) throw new DomainError('cloud.errors.priceChanged', { name: p.name }, 409)
    items.push({ p, price, qty })
    wanted.set(p.id, (wanted.get(p.id) ?? 0) + qty)
  }
  if (!allowNegative) {
    for (const it of items) {
      const need = wanted.get(it.p.id) ?? 0
      if (need > it.p.stock + QTY_EPS) throw new DomainError('cloud.errors.insufficientStock', { name: it.p.name, stock: it.p.stock, unit: it.p.unit }, 409)
    }
  }
  if (discountIn > 0 && !isOwner && ctx.setting('cashier_discount', '0') !== '1') {
    throw new DomainError('cloud.errors.discountNotAllowed', {}, 403)
  }

  const subtotal = items.reduce((s, it) => s + Math.round(it.qty * it.price), 0)
  const discount = Math.min(Math.max(0, discountIn), subtotal)
  const total = Math.max(0, subtotal - discount)
  const paid = paidCash + paidCard
  const debt = Math.max(0, total - paid)

  if (debt > 0 && cust.is_walk_in) throw new DomainError('sales.noDebtForWalkIn')

  const paymentStatus = debt <= 0 ? 'paid' : paid <= 0 ? 'debt' : 'partial'
  const receipt = nextReceiptNumber(ctx, shift.id)
  const now = ctx.now()

  const sale = ctx.sql.get<{ id: number }>(
    `INSERT INTO sales(receipt_number, shift_id, customer_id, total, discount, paid_cash, paid_card, paid_amount, debt_amount, payment_status, note, created_at, user_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    receipt, shift.id, customerId, total, discount, paidCash, paidCard, paid, debt, paymentStatus, note ?? null, now, ctx.actor.uid,
  )!
  for (const it of items) {
    ctx.sql.run(
      'INSERT INTO sale_items(sale_id, product_id, product_name, price, cost_price, qty, unit, subtotal) VALUES(?,?,?,?,?,?,?,?)',
      sale.id, it.p.id, it.p.name, it.price, Math.round(it.p.cost_price ?? 0), it.qty, it.p.unit, Math.round(it.qty * it.price),
    )
    ctx.sql.run('UPDATE products SET stock = stock - ? WHERE id = ?', it.qty, it.p.id)
  }
  if (debt > 0 && !cust.is_walk_in) {
    ctx.sql.run('UPDATE customers SET balance = balance - ? WHERE id = ?', debt, customerId)
  }
  return ctx.sql.get<Sale>('SELECT * FROM sales WHERE id = ?', sale.id)!
}

type SaleReturn = Record<string, unknown> & { id: number; sale_id: number }
type SaleReturnItem = Record<string, unknown> & { return_id: number }

function returnsForSales(ctx: Ctx, saleIds: number[]): Map<number, (SaleReturn & { items: SaleReturnItem[] })[]> {
  const map = new Map<number, (SaleReturn & { items: SaleReturnItem[] })[]>()
  if (saleIds.length === 0) return map
  const ids = jsonList(saleIds)
  const rets = ctx.sql.all<SaleReturn>('SELECT * FROM sale_returns WHERE sale_id IN (SELECT value FROM json_each(?)) ORDER BY id', ids)
  const items = ctx.sql.all<SaleReturnItem>(
    'SELECT ri.* FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE r.sale_id IN (SELECT value FROM json_each(?)) ORDER BY ri.id',
    ids,
  )
  const byReturn = new Map<number, SaleReturnItem[]>()
  for (const it of items) byReturn.set(it.return_id, [...(byReturn.get(it.return_id) ?? []), it])
  for (const r of rets) map.set(r.sale_id, [...(map.get(r.sale_id) ?? []), { ...r, items: byReturn.get(r.id) ?? [] }])
  return map
}

function listSales(ctx: Ctx, raw: unknown) {
  const f = v.optObj(v.args(raw)[0], 'filter')
  const where: string[] = []
  const args: (string | number)[] = []
  const status = v.optStr(f.paymentStatus, 'paymentStatus', 20)
  if (status) { where.push('s.payment_status = ?'); args.push(status) }
  if (f.returnedOnly) where.push('EXISTS (SELECT 1 FROM sale_returns r WHERE r.sale_id = s.id)')
  const search = v.optStr(f.search, 'search', 100)
  if (search) { where.push('s.receipt_number LIKE ?'); args.push(`%${search}%`) }
  const from = v.optDay(f.dateFrom, 'dateFrom')
  if (from) { where.push('date(s.created_at) >= date(?)'); args.push(from) }
  const to = v.optDay(f.dateTo, 'dateTo')
  if (to) { where.push('date(s.created_at) <= date(?)'); args.push(to) }
  const productId = v.optId(f.productId, 'productId')
  if (productId) { where.push('s.id IN (SELECT sale_id FROM sale_items WHERE product_id = ?)'); args.push(productId) }
  const customerId = v.optId(f.customerId, 'customerId')
  if (customerId) { where.push('s.customer_id = ?'); args.push(customerId) }
  // Kassir faqat o'z sotuvlarini ko'radi.
  if (ctx.actor.role !== 'owner') { where.push('s.user_id = ?'); args.push(ctx.actor.uid) }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const sales = ctx.sql.all<Sale & { returns_count: number }>(
    `SELECT s.*, c.name customer_name, c.is_walk_in is_walk_in,
            COALESCE((SELECT SUM(r.amount) FROM sale_returns r WHERE r.sale_id = s.id), 0) returned_amount,
            (SELECT COUNT(*) FROM sale_returns r WHERE r.sale_id = s.id) returns_count
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ${w} ORDER BY s.id DESC LIMIT 200`,
    ...args,
  )
  const returns = returnsForSales(ctx, sales.filter((s) => s.returns_count > 0).map((s) => s.id))
  // Desktop har sotuvga alohida so'rov yuborardi (N+1) — bu yerda bitta so'rov.
  const items = sales.length
    ? ctx.sql.all<Record<string, unknown> & { sale_id: number }>(
      `SELECT si.*, COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0) returned_qty
       FROM sale_items si WHERE si.sale_id IN (SELECT value FROM json_each(?)) ORDER BY si.id`,
      jsonList(sales.map((s) => s.id)),
    )
    : []
  const bySale = new Map<number, typeof items>()
  for (const it of items) bySale.set(it.sale_id, [...(bySale.get(it.sale_id) ?? []), it])
  return sales.map(({ returns_count: _, ...s }) => ({ ...s, items: bySale.get(s.id) ?? [], returns: returns.get(s.id) ?? [] }))
}

const RETURN_METHOD_SQL = {
  cash: 'r.refund_cash > 0',
  card: 'r.refund_card > 0',
  balance: 'r.refund_balance > 0',
} as const

function listReturns(ctx: Ctx, raw: unknown) {
  const f = v.optObj(v.args(raw)[0], 'filter')
  const where: string[] = []
  const args: (string | number)[] = []
  const customerId = v.optId(f.customerId, 'customerId')
  if (customerId) { where.push('r.customer_id = ?'); args.push(customerId) }
  const productId = v.optId(f.productId, 'productId')
  if (productId) { where.push('EXISTS (SELECT 1 FROM sale_return_items ri WHERE ri.return_id = r.id AND ri.product_id = ?)'); args.push(productId) }
  const from = v.optDay(f.dateFrom, 'dateFrom')
  if (from) { where.push('date(r.created_at) >= date(?)'); args.push(from) }
  const to = v.optDay(f.dateTo, 'dateTo')
  if (to) { where.push('date(r.created_at) <= date(?)'); args.push(to) }
  const method = v.optOneOf(f.method, 'method', ['cash', 'card', 'balance'] as const)
  if (method) where.push(RETURN_METHOD_SQL[method])
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const rows = ctx.sql.all<SaleReturn>(
    `SELECT r.*, s.receipt_number, c.name customer_name, c.is_walk_in is_walk_in
     FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers c ON c.id = r.customer_id
     ${w} ORDER BY r.id DESC LIMIT 500`,
    ...args,
  )
  const byReturn = new Map<number, SaleReturnItem[]>()
  if (rows.length) {
    const items = ctx.sql.all<SaleReturnItem>(
      'SELECT * FROM sale_return_items WHERE return_id IN (SELECT value FROM json_each(?)) ORDER BY id',
      jsonList(rows.map((r) => r.id)),
    )
    for (const it of items) byReturn.set(it.return_id, [...(byReturn.get(it.return_id) ?? []), it])
  }
  return rows.map((r) => ({ ...r, items: byReturn.get(r.id) ?? [] }))
}

export const saleOps: OpTable = {
  createSale: { access: 'cashier', write: true, run: createSale },
  listSales: { access: 'cashier', write: false, run: listSales },
  listReturns: { access: 'owner', write: false, run: listReturns },
  customerReturns: {
    access: 'owner',
    write: false,
    run: (ctx, raw) => ctx.sql.all('SELECT * FROM sale_returns WHERE customer_id = ? ORDER BY id DESC', v.id(v.args(raw)[0])),
  },
  // Shu mahsulot shu mijozga qachon, qancha, qaysi narxda sotilgani (eng yangisi birinchi).
  productCustomerHistory: {
    access: 'cashier',
    write: false,
    run(ctx, raw) {
      const [pid, cid] = v.args(raw)
      return ctx.sql.all(
        `SELECT s.id sale_id, s.receipt_number, s.created_at, si.price, si.qty, si.unit, si.subtotal
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si.product_id = ? AND s.customer_id = ?
         ORDER BY s.id DESC`,
        v.id(pid, 'productId'), v.id(cid, 'customerId'),
      )
    },
  },
}
