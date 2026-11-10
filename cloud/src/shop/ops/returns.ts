import { DomainError, invalid } from '../errors'
import type { Ctx, OpTable } from '../rpc'
import * as v from '../v'
import { allocate, intMoney, normalizeQty, QTY_EPS, QTY_SCALE, roundHalfAway } from '../money'
import { ownOpenShift } from './shifts'

// Chek bo'yicha vozvrat — src-tauri/src/returns.rs porti (formula va xato kodlari bir xil).
// Op nomlari Rust buyruqlari bilan bir xil (klientda `invoke()` shu nomni chaqiradi), xato
// kodi qisqa (`qtyExceeds`) — UI `returnErrorMessage` bilan tarjima qiladi.
// Tranzaksiya — dispetcherda (transactionSync); DO so'rovlarni ketma-ket bajaradi, shuning
// uchun ikki parallel vozvrat bitta tovarni ikki marta qaytara olmaydi.

export const QTY_SNAP = 0.5 / QTY_SCALE
const REASON_MAX_CHARS = 500

export const err = (code: string, params: Record<string, unknown> = {}) => new DomainError(code, params, 422)

export type ReturnLineInput = { saleItemId: number; qty: number }

type SaleRow = { id: number; receipt_number: string; customer_id: number | null; total: number; paid_amount: number; debt_amount: number }
type ItemRow = { id: number; product_id: number | null; product_name: string; price: number; cost_price: number; qty: number; unit: string; subtotal: number; returned: number }
type Prior = { count: number; amount: number; money: number; balance: number }

export type Computed = {
  sale: SaleRow
  items: ItemRow[]
  requested: number[]
  balanceAllowed: boolean
  customerBalance: number
  prior: Prior
  amount: number
  moneyCap: number
  suggestedBalance: number
}

const remaining = (i: ItemRow) => Math.max(0, i.qty - i.returned)

/** Rust'da f64 — JSON'da NaN/Infinity kelmaydi, lekin noto'g'ri tur ham invalidQty. */
function qtyIn(x: unknown): number {
  return typeof x === 'number' ? x : NaN
}

function lineGross(item: ItemRow, cum: number): number {
  if (cum <= QTY_EPS) return 0
  if (cum >= item.qty - QTY_EPS) return item.subtotal
  const g = roundHalfAway(cum * item.price)
  return Math.min(Math.max(g, 0), Math.max(item.subtotal, 0))
}

function loadSale(ctx: Ctx, saleId: number): SaleRow {
  const r = ctx.sql.get<SaleRow>('SELECT id, receipt_number, customer_id, total, paid_amount, debt_amount FROM sales WHERE id = ?', saleId)
  if (!r) throw err('saleNotFound', { saleId })
  return { ...r, total: Math.max(0, intMoney(r.total)), paid_amount: Math.max(0, intMoney(r.paid_amount)), debt_amount: Math.max(0, intMoney(r.debt_amount)) }
}

function loadItems(ctx: Ctx, saleId: number): ItemRow[] {
  return ctx.sql.all<ItemRow>(
    `SELECT si.id, si.product_id, si.product_name, si.unit,
            CAST(si.price AS REAL) price, CAST(si.cost_price AS REAL) cost_price, CAST(si.qty AS REAL) qty,
            si.subtotal subtotal,
            CAST(COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0) AS REAL) returned
     FROM sale_items si WHERE si.sale_id = ? ORDER BY si.id`,
    saleId,
  ).map((r) => ({ ...r, subtotal: intMoney(r.subtotal) }))
}

function loadPrior(ctx: Ctx, saleId: number): Prior {
  const r = ctx.sql.get<{ c: number; amount: number; money: number; balance: number }>(
    `SELECT COUNT(*) c, COALESCE(SUM(amount), 0) amount, COALESCE(SUM(refund_cash + refund_card), 0) money,
            COALESCE(SUM(refund_balance), 0) balance
     FROM sale_returns WHERE sale_id = ?`,
    saleId,
  )!
  return { count: r.c, amount: intMoney(r.amount), money: intMoney(r.money), balance: intMoney(r.balance) }
}

/** [yo'l-yo'lakaymi, balans] yoki null. */
export function loadCustomer(ctx: Ctx, id: number): [boolean, number] | null {
  const r = ctx.sql.get<{ walk_in: number; balance: number }>('SELECT is_walk_in walk_in, balance FROM customers WHERE id = ?', id)
  return r ? [Number(r.walk_in) !== 0, intMoney(r.balance)] : null
}

/** So'rovni tekshiradi va summani hisoblaydi. Hech narsa yozmaydi (quote va create bir xil). */
export function compute(ctx: Ctx, saleId: number, lines: ReturnLineInput[]): Computed {
  const sale = loadSale(ctx, saleId)
  const items = loadItems(ctx, saleId)
  const requested = items.map(() => 0)
  const seen = new Set<number>()
  for (const l of lines) {
    const idx = items.findIndex((i) => i.id === l.saleItemId)
    if (idx < 0) throw err('lineNotInSale', { saleItemId: l.saleItemId })
    const item = items[idx]
    const name = { name: item.product_name }
    if (seen.has(l.saleItemId)) throw err('duplicateLine', name)
    seen.add(l.saleItemId)
    if (!Number.isFinite(l.qty) || l.qty <= 0) throw err('invalidQty', name)
    const q = normalizeQty(l.qty)
    if (q <= 0) throw err('invalidQty', name)
    const rem = remaining(item)
    if (rem <= QTY_EPS) throw err('alreadyReturned', name)
    if (q > rem + QTY_SNAP) throw err('qtyExceeds', { name: item.product_name, max: normalizeQty(rem), unit: item.unit })
    requested[idx] = q >= rem - QTY_SNAP ? rem : q
  }

  const prior = loadPrior(ctx, saleId)
  const grossTotal = items.reduce((s, i) => s + Math.max(0, i.subtotal), 0)
  const grossAfter = items.reduce((s, i, k) => s + lineGross(i, i.returned + requested[k]), 0)
  const any = requested.some((q) => q > 0)
  const amount = any ? Math.max(0, allocate(sale.total, grossAfter, grossTotal) - prior.amount) : 0

  const customer = sale.customer_id !== null ? loadCustomer(ctx, sale.customer_id) : null
  const balanceAllowed = customer !== null && !customer[0]
  const customerBalance = customer ? customer[1] : 0

  let moneyCap: number, suggestedBalance: number
  if (balanceAllowed) {
    const saleCap = Math.max(0, Math.min(sale.paid_amount, sale.total) - prior.money)
    moneyCap = Math.min(Math.max(Math.max(saleCap, customerBalance + amount), 0), amount)
    const outstanding = Math.max(0, sale.debt_amount - prior.balance)
    const owed = Math.max(0, -customerBalance)
    suggestedBalance = Math.max(Math.min(amount, outstanding, owed), amount - moneyCap)
  } else {
    moneyCap = amount
    suggestedBalance = 0
  }
  return { sale, items, requested, balanceAllowed, customerBalance, prior, amount, moneyCap, suggestedBalance }
}

export function parseLines(x: unknown): ReturnLineInput[] {
  return v.arr(x ?? [], 'lines', 500).map((raw, i) => {
    const o = v.obj(raw, `lines.${i}`)
    return { saleItemId: v.id(o.saleItemId, `lines.${i}.saleItemId`), qty: qtyIn(o.qty) }
  })
}

export function quoteOn(ctx: Ctx, saleId: number, lines: ReturnLineInput[]) {
  const c = compute(ctx, saleId, lines)
  return {
    saleId: c.sale.id,
    receiptNumber: c.sale.receipt_number,
    saleTotal: c.sale.total,
    alreadyRefunded: c.prior.amount,
    customerId: c.sale.customer_id,
    balanceAllowed: c.balanceAllowed,
    customerBalance: c.customerBalance,
    lines: c.items.map((i, k) => ({
      saleItemId: i.id, productId: i.product_id, productName: i.product_name, unit: i.unit, price: i.price,
      qtySold: i.qty, qtyReturned: i.returned, qtyRemaining: remaining(i), qty: c.requested[k],
    })),
    amount: c.amount,
    moneyCap: c.moneyCap,
    suggestedBalance: c.suggestedBalance,
    shiftOpen: ownOpenShift(ctx) !== null,
  }
}

/** `reason` — xom qiymat: Rust kabi u summa va qatorlar tekshirilgandan KEYIN tekshiriladi. */
export type ReturnRequest = { saleId: number; lines: ReturnLineInput[]; refundCash: number; refundCard: number; refundBalance: number; reason: unknown }

export function parseRefund(x: unknown, field: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || !Number.isInteger(x)) throw invalid(field)
  return x
}

export function cleanReason(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') throw invalid('reason')
  const r = raw.trim()
  if (!r) return null
  if ([...r].length > REASON_MAX_CHARS) throw err('reasonTooLong', { max: REASON_MAX_CHARS })
  return r
}

/** Tekshiradi va yozadi. Dispetcher tranzaksiyasi ichida chaqiriladi. */
export function createOn(ctx: Ctx, req: ReturnRequest) {
  const c = compute(ctx, req.saleId, req.lines)
  if (!c.requested.some((q) => q > 0)) throw err('noLines')
  const reason = cleanReason(req.reason)
  const shift = ownOpenShift(ctx)
  if (!shift) throw err('noShift')
  if (req.refundCash < 0 || req.refundCard < 0 || req.refundBalance < 0) throw err('refundNegative')
  const sum = req.refundCash + req.refundCard + req.refundBalance
  if (!Number.isSafeInteger(sum) || sum !== c.amount) throw err('refundMismatch', { amount: c.amount })
  if (req.refundBalance > 0 && !c.balanceAllowed) throw err('walkInBalance')
  if (req.refundCash + req.refundCard > c.moneyCap) throw err('cashExceedsCap', { max: c.moneyCap })

  const returnNumber = `${c.sale.receipt_number}-V${c.prior.count + 1}`
  const createdAt = ctx.now()
  const ret = ctx.sql.get<{ id: number }>(
    `INSERT INTO sale_returns(sale_id, shift_id, customer_id, return_number, amount, refund_cash, refund_card, refund_balance, reason, created_at, user_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    c.sale.id, shift.id, c.sale.customer_id, returnNumber, c.amount, req.refundCash, req.refundCard, req.refundBalance, reason, createdAt, ctx.actor.uid,
  )!
  const items: { saleItemId: number; productName: string; qty: number; unit: string; price: number; subtotal: number }[] = []
  c.items.forEach((item, k) => {
    const q = c.requested[k]
    if (q <= 0) return
    const subtotal = lineGross(item, item.returned + q) - lineGross(item, item.returned)
    ctx.sql.run(
      `INSERT INTO sale_return_items(return_id, sale_item_id, product_id, product_name, price, cost_price, qty, unit, subtotal)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      ret.id, item.id, item.product_id, item.product_name, item.price, item.cost_price, q, item.unit, subtotal,
    )
    if (item.product_id !== null) ctx.sql.run('UPDATE products SET stock = stock + ? WHERE id = ?', q, item.product_id)
    items.push({ saleItemId: item.id, productName: item.product_name, qty: q, unit: item.unit, price: item.price, subtotal })
  })
  if (req.refundBalance > 0 && c.sale.customer_id !== null) {
    ctx.sql.run('UPDATE customers SET balance = balance + ? WHERE id = ?', req.refundBalance, c.sale.customer_id)
  }
  return {
    id: ret.id, returnNumber, saleId: c.sale.id, receiptNumber: c.sale.receipt_number, amount: c.amount,
    refundCash: req.refundCash, refundCard: req.refundCard, refundBalance: req.refundBalance, reason, createdAt, items,
  }
}

export function parseReturnRequest(x: unknown): ReturnRequest {
  const r = v.obj(x, 'request')
  return {
    saleId: v.id(r.saleId, 'saleId'),
    lines: parseLines(r.lines),
    refundCash: parseRefund(r.refundCash ?? 0, 'refundCash'),
    refundCard: parseRefund(r.refundCard ?? 0, 'refundCard'),
    refundBalance: parseRefund(r.refundBalance ?? 0, 'refundBalance'),
    reason: r.reason,
  }
}

export const returnOps: OpTable = {
  return_quote: {
    access: 'owner',
    write: false,
    run(ctx, raw) {
      const a = v.obj(raw, 'args')
      return quoteOn(ctx, v.id(a.saleId, 'saleId'), parseLines(a.lines))
    },
  },
  create_return: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      return createOn(ctx, parseReturnRequest(v.obj(raw, 'args').request))
    },
  },
}
