import { invoke } from '@tauri-apps/api/core'
import { db } from './db'
import { t } from './i18n'
import { moneySum } from './format'
import { printReceipt } from './print'

// Vozvrat mantiqi Rust'da (src-tauri/src/returns.rs): bitta tranzaksiya, summa va
// tekshiruvlar o'sha yerda. Bu fayl — yupqa IPC qatlami + xato matnlari + chek.

export type ReturnLineInput = { saleItemId: number; qty: number }

export type ReturnQuoteLine = {
  saleItemId: number
  productId: number | null
  productName: string
  unit: string
  price: number
  qtySold: number
  qtyReturned: number
  qtyRemaining: number
  qty: number
}

export type ReturnQuote = {
  saleId: number
  receiptNumber: string
  saleTotal: number
  alreadyRefunded: number
  customerId: number | null
  balanceAllowed: boolean
  customerBalance: number
  lines: ReturnQuoteLine[]
  amount: number
  moneyCap: number
  suggestedBalance: number
  shiftOpen: boolean
}

export type ReturnRequest = {
  saleId: number
  lines: ReturnLineInput[]
  refundCash: number
  refundCard: number
  refundBalance: number
  reason: string | null
}

export type CreatedReturn = {
  id: number
  returnNumber: string
  saleId: number
  receiptNumber: string
  amount: number
  refundCash: number
  refundCard: number
  refundBalance: number
  reason: string | null
  createdAt: string
  items: { saleItemId: number; productName: string; qty: number; unit: string; price: number; subtotal: number }[]
}

type ReturnError = { code: string; params?: Record<string, unknown> }

function isReturnError(e: unknown): e is ReturnError {
  return typeof e === 'object' && e !== null && typeof (e as ReturnError).code === 'string'
}

// Rust xato kodini foydalanuvchi tilidagi matnga aylantiradi. Pul parametrlari formatlanadi.
export function returnErrorMessage(e: unknown): string {
  if (!isReturnError(e)) return e instanceof Error ? e.message : String(e)
  const p: Record<string, unknown> = { ...(e.params ?? {}) }
  for (const k of ['amount', 'max'] as const) {
    if (typeof p[k] === 'number' && e.code !== 'qtyExceeds') p[k] = moneySum(p[k] as number)
  }
  const key = `returns.errors.${e.code}`
  const msg = t(key, p)
  return msg === key ? t('returns.errors.unknown', { code: e.code }) : msg
}

// db() — pool ro'yxatga olingani va sxema self-heal bo'lganiga kafolat (Rust shu pool'ni oladi).
export async function returnQuote(saleId: number, lines: ReturnLineInput[]): Promise<ReturnQuote> {
  await db()
  return invoke<ReturnQuote>('return_quote', { saleId, lines })
}

export async function createReturn(request: ReturnRequest): Promise<CreatedReturn> {
  await db()
  return invoke<CreatedReturn>('create_return', { request })
}

// Vozvrat cheki. Chegirma ulushi = qatorlar summasi − qaytarilgan pul (proporsional taqsimot).
export type ReturnReceiptData = {
  return_number: string
  receipt_number: string
  created_at: string
  customer: string
  items: { name: string; qty: number; unit: string; price: number; subtotal: number }[]
  amount: number
  refund_cash: number
  refund_card: number
  refund_balance: number
}

export function printReturnReceipt(r: ReturnReceiptData) {
  const gross = r.items.reduce((s, i) => s + i.subtotal, 0)
  return printReceipt({
    kind: 'return',
    receipt_number: r.return_number,
    original_receipt: r.receipt_number,
    created_at: r.created_at,
    customer: r.customer,
    items: r.items,
    discount: Math.max(0, gross - r.amount),
    total: r.amount,
    paid_cash: r.refund_cash,
    paid_card: r.refund_card,
    change: 0,
    debt: r.refund_balance,
  })
}

export function createdToReceipt(r: CreatedReturn, customer: string): ReturnReceiptData {
  return {
    return_number: r.returnNumber,
    receipt_number: r.receiptNumber,
    created_at: r.createdAt,
    customer,
    items: r.items.map((i) => ({ name: i.productName, qty: i.qty, unit: i.unit, price: i.price, subtotal: i.subtotal })),
    amount: r.amount,
    refund_cash: r.refundCash,
    refund_card: r.refundCard,
    refund_balance: r.refundBalance,
  }
}

// Miqdorni ko'rsatish: 3 xonagacha, ortiqcha nolsiz (0.75, 2, 1.333).
export function fmtQty(q: number): string {
  return String(Math.round(q * 1000) / 1000)
}
