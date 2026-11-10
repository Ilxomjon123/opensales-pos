import { call, RpcError } from '../rpc'
import { t } from './i18n'
import type * as D from '../../../src/lib/stock'

// Desktop lib/stock.ts: yozish (kirim/bekor/tuzatish) desktop modulida invoke() orqali —
// bulutda shim RPC'ga yo'naltiradi, shuning uchun o'sha funksiyalar to'g'ridan-to'g'ri
// qayta eksport qilinadi. O'qish so'rovlari (xom SQL) — RPC.
export { createStockReceipt, voidStockReceipt, adjustProductStock, stockErrorMessage, moveSummary } from '../../../src/lib/stock'
export type {
  ReceiptLineInput, ReceiptRequest, CreatedReceipt, StockAdjusted, AdjustKind, StockReceipt, StockReceiptItem,
  StockReceiptRow, ReceiptStatus, ReceiptsFilter, MovementRow, MoveKind, ProductMove, MoveSummary,
} from '../../../src/lib/stock'

async function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  try { return await call<T>(op, args) } catch (e) { throw e instanceof RpcError ? new Error(t(e.code, e.params)) : e }
}

export const listStockReceipts: typeof D.listStockReceipts = (f = {}) => rpc('listStockReceipts', f)
export const receiptSuppliers: typeof D.receiptSuppliers = () => rpc('receiptSuppliers')
export const stockMovementReport: typeof D.stockMovementReport = (from, to) => rpc('stockMovementReport', from, to)
export const productMoves: typeof D.productMoves = (pid, walkInLabel) => rpc('productMoves', pid, walkInLabel)
