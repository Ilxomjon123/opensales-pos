import { DomainError } from '../errors'
import type { Ctx, OpTable } from '../rpc'
import * as v from '../v'
import { normalizeQty, QTY_EPS, roundHalfAway } from '../money'
import { catalogSource } from '../catalogSync'

// Kirim (prixod), bekor qilish, qoldiqni qo'lda tuzatish — src-tauri/src/stock.rs porti.
// Xato kodlari qisqa (`invalidQty`) — UI `stockErrorMessage` bilan tarjima qiladi.

const MAX_LINES = 500
const SUPPLIER_MAX_CHARS = 120
const NOTE_MAX_CHARS = 500
const AMOUNT_MAX = 1e12

const err = (code: string, params: Record<string, unknown> = {}) => new DomainError(code, params, 422)

type ProductRow = { id: number; name: string; unit: string; stock: number; cost: number; price: number }

/** Bo'sh matn → null; uzun bo'lsa xato. */
function cleanText(s: unknown, max: number, code: string): string | null {
  if (s === null || s === undefined) return null
  if (typeof s !== 'string') throw err(code, { max })
  const t = s.trim()
  if (!t) return null
  if ([...t].length > max) throw err(code, { max })
  return t
}

const num = (x: unknown) => (typeof x === 'number' ? x : NaN)

function money(x: number, code: string, name: string): number {
  if (!Number.isFinite(x) || x < 0 || x > AMOUNT_MAX) throw err(code, { name })
  return roundHalfAway(x)
}

export function weightedCost(stock: number, cost: number, qty: number, inCost: number): number {
  if (inCost <= 0) return roundHalfAway(cost)
  if (stock <= QTY_EPS || cost <= 0) return inCost
  return roundHalfAway((stock * cost + qty * inCost) / (stock + qty))
}

function loadProduct(ctx: Ctx, id: number): ProductRow {
  const r = ctx.sql.get<ProductRow>(
    'SELECT id, name, unit, CAST(stock AS REAL) stock, CAST(cost_price AS REAL) cost, CAST(price AS REAL) price FROM products WHERE id = ?', id,
  )
  if (!r) throw err('productNotFound', { productId: id })
  return r
}

/** Sana: SQLite o'zi tekshiradi va bir xil ko'rinishga keltiradi; kelajakdagi kun rad. */
function receivedAt(ctx: Ctx, raw: unknown): string {
  const now = ctx.now()
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) return now
  if (typeof raw !== 'string' || raw.length > 40) throw err('invalidDate')
  const r = ctx.sql.get<{ iso: string | null; future: number }>(
    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1) iso, CAST(date(?1) > date(?2, '+1 day') AS INTEGER) future",
    raw.trim(), now,
  )!
  if (!r.iso) throw err('invalidDate')
  if (r.future) throw err('futureDate')
  return r.iso
}

export function createReceipt(ctx: Ctx, raw: unknown) {
  const req = v.obj(raw, 'request')
  const linesIn = Array.isArray(req.lines) ? req.lines : []
  if (linesIn.length === 0) throw err('noLines')
  if (linesIn.length > MAX_LINES) throw err('tooManyLines', { max: MAX_LINES })
  const supplier = cleanText(req.supplier, SUPPLIER_MAX_CHARS, 'supplierTooLong')
  const note = cleanText(req.note, NOTE_MAX_CHARS, 'noteTooLong')
  const received = receivedAt(ctx, req.receivedAt)

  const seen = new Set<number>()
  const lines: { p: ProductRow; qty: number; cost: number; salePrice: number | null; subtotal: number }[] = []
  for (const [i, lr] of linesIn.entries()) {
    const l = v.obj(lr, `lines.${i}`)
    const p = loadProduct(ctx, v.id(l.productId, `lines.${i}.productId`))
    const name = { name: p.name }
    if (seen.has(p.id)) throw err('duplicateLine', name)
    seen.add(p.id)
    const q = num(l.qty)
    if (!Number.isFinite(q) || q <= 0 || q > AMOUNT_MAX) throw err('invalidQty', name)
    const qty = normalizeQty(q)
    if (qty <= 0) throw err('invalidQty', name)
    const cost = money(num(l.costPrice), 'invalidCost', p.name)
    const salePrice = l.salePrice === null || l.salePrice === undefined ? null : money(num(l.salePrice), 'invalidPrice', p.name)
    lines.push({ p, qty, cost, salePrice, subtotal: roundHalfAway(qty * cost) })
  }
  const total = lines.reduce((s, l) => s + l.subtotal, 0)
  if (!Number.isSafeInteger(total)) throw err('totalTooLarge')

  const id = ctx.sql.get<{ id: number }>(
    "INSERT INTO stock_receipts(receipt_number, supplier, note, total, received_at, created_at, user_id) VALUES('', ?, ?, ?, ?, ?, ?) RETURNING id",
    supplier, note, total, received, ctx.now(), ctx.actor.uid,
  )!.id
  // Raqam id'dan — AUTOINCREMENT qaytarilmaydi, ikki kirimga bir raqam tushmaydi.
  const receiptNumber = `K-${String(id).padStart(5, '0')}`
  ctx.sql.run('UPDATE stock_receipts SET receipt_number = ? WHERE id = ?', receiptNumber, id)

  for (const { p, qty, cost, salePrice, subtotal } of lines) {
    const costAfter = weightedCost(p.stock, p.cost, qty, cost)
    // Narx o'zgarmagan bo'lsa yozmaymiz — bekor qilishda tiklanadigan narsa yo'q.
    const newPrice = salePrice !== null && Math.abs(salePrice - p.price) >= 0.5 ? salePrice : null
    // Filialda narx asosiy do'konda boshqariladi (katalog umumiy).
    if (newPrice !== null && catalogSource(ctx.sql)) throw new DomainError('cloud.shops.errors.catalogManagedByMaster', {}, 403)
    ctx.sql.run(
      `INSERT INTO stock_receipt_items(receipt_id, product_id, product_name, unit, qty, cost_price, subtotal, cost_before, cost_after, price_before, sale_price)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, p.id, p.name, p.unit, qty, cost, subtotal, p.cost, costAfter, newPrice !== null ? p.price : null, newPrice,
    )
    ctx.sql.run('UPDATE products SET stock = stock + ?, cost_price = ?, price = COALESCE(?, price) WHERE id = ?', qty, costAfter, newPrice, p.id)
  }
  return { id, receiptNumber, total, receivedAt: received, lines: lines.length }
}

function voidReceipt(ctx: Ctx, raw: unknown) {
  const a = v.obj(raw, 'args')
  const receiptId = v.id(a.receiptId, 'receiptId')
  const reason = cleanText(a.reason, NOTE_MAX_CHARS, 'noteTooLong')
  const r = ctx.sql.get<{ receipt_number: string; voided_at: string | null; transfer_id: string | null }>('SELECT receipt_number, voided_at, transfer_id FROM stock_receipts WHERE id = ?', receiptId)
  if (!r) throw err('receiptNotFound', { receiptId })
  if (r.voided_at) throw err('alreadyVoided', { number: r.receipt_number })
  // Do'konlararo ko'chirish kirimi: ikkinchi do'kondagi chiqim bilan juft — alohida bekor qilinmaydi.
  if (r.transfer_id) throw new DomainError('cloud.transfers.errors.cannotVoid', { number: r.receipt_number }, 409)
  const items = ctx.sql.all<{ id: number; product_id: number | null; qty: number; cost_before: number; cost_after: number; price_before: number | null; sale_price: number | null }>(
    `SELECT id, product_id, CAST(qty AS REAL) qty, CAST(cost_before AS REAL) cost_before, CAST(cost_after AS REAL) cost_after,
            CAST(price_before AS REAL) price_before, CAST(sale_price AS REAL) sale_price
     FROM stock_receipt_items WHERE receipt_id = ? ORDER BY id`,
    receiptId,
  )
  const allowNegative = ctx.setting('allow_negative_stock', '0') === '1'
  for (const it of items) {
    if (it.product_id === null) continue
    const p = loadProduct(ctx, it.product_id)
    if (!allowNegative && p.stock - it.qty < -QTY_EPS) {
      throw err('stockWouldGoNegative', { name: p.name, stock: normalizeQty(p.stock), qty: it.qty, unit: p.unit })
    }
    const later = ctx.sql.get<{ c: number }>(
      `SELECT COUNT(*) c FROM stock_receipt_items i JOIN stock_receipts r ON r.id = i.receipt_id
       WHERE i.product_id = ? AND i.id > ? AND r.voided_at IS NULL`,
      it.product_id, it.id,
    )!.c
    const untouched = (cur: number, set: number) => later === 0 && Math.abs(cur - set) < 0.5
    const cost = untouched(p.cost, it.cost_after) ? it.cost_before : p.cost
    const price = it.sale_price !== null && it.price_before !== null && untouched(p.price, it.sale_price) ? it.price_before : p.price
    ctx.sql.run('UPDATE products SET stock = stock - ?, cost_price = ?, price = ? WHERE id = ?', it.qty, cost, price, it.product_id)
  }
  const voidedAt = ctx.now()
  ctx.sql.run('UPDATE stock_receipts SET voided_at = ?, void_reason = ? WHERE id = ?', voidedAt, reason, receiptId)
  return { id: receiptId, receiptNumber: r.receipt_number, voidedAt }
}

function adjust(ctx: Ctx, raw: unknown) {
  const a = v.obj(raw, 'args')
  const kind = a.kind === 'initial' || a.kind === 'manual' ? a.kind : null
  if (!kind) throw err('invalidKind')
  const note = cleanText(a.note, NOTE_MAX_CHARS, 'noteTooLong')
  const productId = v.id(a.productId, 'productId')
  const p = loadProduct(ctx, productId)
  const newStock = num(a.newStock)
  if (!Number.isFinite(newStock) || newStock < 0 || newStock > AMOUNT_MAX) throw err('invalidStock', { name: p.name })
  const after = normalizeQty(newStock)
  const delta = normalizeQty(after - p.stock)
  if (Math.abs(delta) < QTY_EPS) return { productId, qtyBefore: p.stock, qtyAfter: p.stock, delta: 0, recorded: false }
  ctx.sql.run('UPDATE products SET stock = ? WHERE id = ?', after, p.id)
  ctx.sql.run(
    'INSERT INTO stock_adjustments(product_id, product_name, unit, qty_before, qty_after, delta, kind, note, created_at, user_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
    p.id, p.name, p.unit, p.stock, after, delta, kind, note, ctx.now(), ctx.actor.uid,
  )
  return { productId, qtyBefore: p.stock, qtyAfter: after, delta, recorded: true }
}

export const stockOps: OpTable = {
  create_stock_receipt: { access: 'owner', write: true, run: (ctx, raw) => createReceipt(ctx, v.obj(raw, 'args').request) },
  void_stock_receipt: { access: 'owner', write: true, run: voidReceipt },
  adjust_product_stock: { access: 'owner', write: true, run: adjust },
}
