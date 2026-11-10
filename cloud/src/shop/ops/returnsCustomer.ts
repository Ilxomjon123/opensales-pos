import type { Ctx, OpTable } from '../rpc'
import * as v from '../v'
import { normalizeQty, QTY_EPS } from '../money'
import { ownOpenShift } from './shifts'
import { cleanReason, compute, createOn, err, loadCustomer, parseRefund, QTY_SNAP, type ReturnLineInput } from './returns'

// Mijoz bo'yicha vozvrat — src-tauri/src/returns/customer.rs porti. Tovar + miqdor →
// mijozning cheklariga ENG YANGISIDAN taqsimlanadi, har chekka alohida createOn, hammasi
// bitta tranzaksiyada (dispetcher). Faqat nomli mijoz.

type ProductQty = { productId: number; qty: number }
type CustItem = { id: number; sale_id: number; created_at: string; product_id: number; product_name: string; unit: string; price: number; qty: number; returned: number }
type Plan = [number, ReturnLineInput[]][]
type Allocation = {
  saleId: number; receiptNumber: string; createdAt: string
  lines: { saleItemId: number; productName: string; unit: string; qty: number; price: number }[]
  amount: number; moneyCap: number; suggestedBalance: number
}

const remaining = (i: CustItem) => Math.max(0, i.qty - i.returned)

function loadItems(ctx: Ctx, customerId: number): CustItem[] {
  return ctx.sql.all<CustItem>(
    `SELECT si.id, si.sale_id, s.created_at, si.product_id, si.product_name, si.unit,
            CAST(si.price AS REAL) price, CAST(si.qty AS REAL) qty,
            CAST(COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0) AS REAL) returned
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.customer_id = ? AND si.product_id IS NOT NULL
     ORDER BY s.id DESC, si.id DESC`,
    customerId,
  )
}

function returnableProducts(items: CustItem[]) {
  const out: { productId: number; productName: string; unit: string; qtySold: number; qtyReturned: number; qtyRemaining: number; lastPrice: number }[] = []
  for (const it of items) {
    const p = out.find((x) => x.productId === it.product_id)
    if (p) { p.qtySold += it.qty; p.qtyReturned += it.returned; p.qtyRemaining += remaining(it) }
    else out.push({ productId: it.product_id, productName: it.product_name, unit: it.unit, qtySold: it.qty, qtyReturned: it.returned, qtyRemaining: remaining(it), lastPrice: it.price })
  }
  return out.filter((p) => p.qtyRemaining > QTY_EPS)
}

function namedCustomer(ctx: Ctx, customerId: number): number {
  const c = loadCustomer(ctx, customerId)
  if (!c) throw err('customerNotFound', { customerId })
  if (c[0]) throw err('walkInNeedsReceipt')
  return c[1]
}

function plan(items: CustItem[], lines: ProductQty[]): Plan {
  const out: Plan = []
  const seen = new Set<number>()
  for (const l of lines) {
    const rows = items.filter((i) => i.product_id === l.productId)
    const first = rows[0]
    if (!first) throw err('productNotBought', { productId: l.productId })
    const name = { name: first.product_name }
    if (seen.has(l.productId)) throw err('duplicateLine', name)
    seen.add(l.productId)
    if (!Number.isFinite(l.qty) || l.qty <= 0) throw err('invalidQty', name)
    const q = normalizeQty(l.qty)
    if (q <= 0) throw err('invalidQty', name)
    const total = rows.reduce((s, i) => s + remaining(i), 0)
    if (total <= QTY_EPS) throw err('alreadyReturned', name)
    if (q > total + QTY_SNAP) throw err('qtyExceeds', { name: first.product_name, max: normalizeQty(total), unit: first.unit })
    let left = q
    for (const it of rows) {
      const rem = remaining(it)
      if (rem <= QTY_EPS) continue
      const take = left >= rem - QTY_SNAP ? rem : left
      const line = { saleItemId: it.id, qty: take }
      const slot = out.find(([sid]) => sid === it.sale_id)
      if (slot) slot[1].push(line)
      else out.push([it.sale_id, [line]])
      left -= take
      if (left <= QTY_SNAP) break
    }
  }
  out.sort((a, b) => b[0] - a[0])
  return out
}

function allocations(ctx: Ctx, items: CustItem[], p: Plan): Allocation[] {
  return p.map(([saleId, lines]) => {
    const c = compute(ctx, saleId, lines)
    const meta = items.find((i) => i.sale_id === saleId)
    return {
      saleId,
      receiptNumber: c.sale.receipt_number,
      createdAt: meta?.created_at ?? '',
      lines: c.items.map((i, k) => ({ i, q: c.requested[k] })).filter(({ q }) => q > 0)
        .map(({ i, q }) => ({ saleItemId: i.id, productName: i.product_name, unit: i.unit, qty: q, price: i.price })),
      amount: c.amount,
      moneyCap: c.moneyCap,
      suggestedBalance: c.suggestedBalance,
    }
  })
}

/**
 * Umumiy (naqd, karta, balans) ni cheklarga taqsimlaydi. Har chekda balans ∈
 * [summa − pul chegarasi, summa]; avval taklif qilingan joyga, keyin qolganiga; karta
 * pul qismlariga ketma-ket, qolgani naqd. Natija: har chek uchun [naqd, karta, balans].
 */
export function splitRefunds(allocs: Pick<Allocation, 'amount' | 'moneyCap' | 'suggestedBalance'>[], cash: number, card: number, balance: number): [number, number, number][] {
  const amount = allocs.reduce((s, a) => s + a.amount, 0)
  if (cash < 0 || card < 0 || balance < 0) throw err('refundNegative')
  const sum = cash + card + balance
  if (!Number.isSafeInteger(sum) || sum !== amount) throw err('refundMismatch', { amount })
  const lower = allocs.map((a) => Math.max(0, a.amount - a.moneyCap))
  const minBalance = lower.reduce((s, x) => s + x, 0)
  if (balance < minBalance) throw err('cashExceedsCap', { max: amount - minBalance })
  const bal = [...lower]
  let left = balance - minBalance
  allocs.forEach((a, k) => { const add = Math.min(left, Math.max(0, a.suggestedBalance - bal[k])); bal[k] += add; left -= add })
  allocs.forEach((a, k) => { const add = Math.min(left, a.amount - bal[k]); bal[k] += add; left -= add })
  let cardLeft = card
  return allocs.map((a, k) => {
    const money = a.amount - bal[k]
    const c = Math.min(cardLeft, money)
    cardLeft -= c
    return [money - c, c, bal[k]]
  })
}

function parseLines(x: unknown): ProductQty[] {
  return v.arr(x ?? [], 'lines', 500).map((raw, i) => {
    const o = v.obj(raw, `lines.${i}`)
    return { productId: v.id(o.productId, `lines.${i}.productId`), qty: typeof o.qty === 'number' ? o.qty : NaN }
  })
}

function quoteOn(ctx: Ctx, customerId: number, lines: ProductQty[]) {
  const customerBalance = namedCustomer(ctx, customerId)
  const items = loadItems(ctx, customerId)
  const allocs = allocations(ctx, items, plan(items, lines))
  const amount = allocs.reduce((s, a) => s + a.amount, 0)
  const moneyCap = allocs.reduce((s, a) => s + a.moneyCap, 0)
  return {
    customerId,
    customerBalance,
    products: returnableProducts(items),
    allocations: allocs,
    amount,
    moneyCap,
    balanceMin: amount - moneyCap,
    suggestedBalance: allocs.reduce((s, a) => s + a.suggestedBalance, 0),
    shiftOpen: ownOpenShift(ctx) !== null,
  }
}

function createOnCustomer(ctx: Ctx, raw: unknown) {
  const r = v.obj(raw, 'request')
  const customerId = v.id(r.customerId, 'customerId')
  const lines = parseLines(r.lines)
  const cash = parseRefund(r.refundCash ?? 0, 'refundCash')
  const card = parseRefund(r.refundCard ?? 0, 'refundCard')
  const balance = parseRefund(r.refundBalance ?? 0, 'refundBalance')
  namedCustomer(ctx, customerId)
  if (lines.length === 0) throw err('noLines')
  const items = loadItems(ctx, customerId)
  const p = plan(items, lines)
  const allocs = allocations(ctx, items, p)
  const split = splitRefunds(allocs, cash, card, balance)
  cleanReason(r.reason) // xato bo'lsa hech narsa yozilmasdan oldin
  // Balansga yozish keyingi cheklarning pul chegarasini faqat oshiradi — oldindan
  // hisoblangan taqsimot har createOn tekshiruvidan o'tadi.
  const returns = p.map(([saleId, ls], k) => createOn(ctx, {
    saleId, lines: ls, refundCash: split[k][0], refundCard: split[k][1], refundBalance: split[k][2], reason: r.reason,
  }))
  return { returns, amount: returns.reduce((s, x) => s + x.amount, 0), refundCash: cash, refundCard: card, refundBalance: balance }
}

export const customerReturnOps: OpTable = {
  customer_return_quote: {
    access: 'owner',
    write: false,
    run(ctx, raw) {
      const a = v.obj(raw, 'args')
      return quoteOn(ctx, v.id(a.customerId, 'customerId'), parseLines(a.lines))
    },
  },
  create_customer_return: {
    access: 'owner',
    write: true,
    run: (ctx, raw) => createOnCustomer(ctx, v.obj(raw, 'args').request),
  },
}
