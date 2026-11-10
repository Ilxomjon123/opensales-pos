import { reactive } from 'vue'
import { call, RpcError } from '../rpc'
import { session } from '../session'
import { t } from './i18n'
import type * as D from '../../../src/lib/db'

// Desktop src/lib/db.ts bilan BIR XIL eksportlar — sahifalar o'zgarmasdan ishlaydi.
// Ma'lumot Worker'dagi do'kon bazasidan (RPC). Xato matni desktopdagidek: server i18n
// kalitini qaytaradi, shu yerda tarjima qilinadi.

export type {
  Category, Product, Customer, Expense, Shift, Sale, SaleItem, SaleReturn, SaleReturnItem, SaleReturnFull, CartLine,
  CustomerPayment, BulkPriceParams, BulkPricePreviewRow, CreateSaleInput, SalesFilter, SaleListItem, SaleListRow,
  ReturnMethod, ReturnsFilter, ReturnListRow, ProductCustomerHistoryRow, ExpenseFilter, ShiftListRow,
} from '../../../src/lib/db'

/** Xom SQL bulutda yo'q — chaqirilsa dasturchi xatosi. */
export async function db(): Promise<{ select: never; execute: never }> {
  const no = () => { throw new Error('Raw SQL is not available in the cloud build') }
  return { select: no as never, execute: no as never }
}

function message(e: unknown): Error {
  if (e instanceof RpcError) {
    const msg = t(e.code, e.params)
    const err = new Error(msg === e.code ? t('cloud.errors.unknown', { code: e.code }) : msg)
    ;(err as Error & { code?: string }).code = e.code
    return err
  }
  return e instanceof Error ? e : new Error(String(e))
}

async function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  try { return await call<T>(op, args) } catch (e) { throw message(e) }
}

// ---- Kesh: ilova ochilganda ro'yxat darhol keshdan, keyin yangilanadi ----
const fetchedThisSession = new Set<string>()
function cacheKey(name: string) {
  return `kassa:c:${session.shop?.id ?? '-'}:${session.user?.uid ?? '-'}:${name}`
}
function store(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* to'la */ }
}
async function swr<T extends unknown[]>(name: string, fetcher: () => Promise<T>): Promise<T> {
  const k = cacheKey(name)
  if (!fetchedThisSession.has(k)) {
    fetchedThisSession.add(k)
    let raw: string | null = null
    try { raw = localStorage.getItem(k) } catch { /* */ }
    if (raw) {
      const arr = reactive(JSON.parse(raw)) as T
      fetcher().then((fresh) => { arr.splice(0, arr.length, ...fresh); store(k, fresh) }).catch(() => {})
      return arr
    }
  }
  const fresh = await fetcher()
  store(k, fresh)
  return fresh
}

// ---- Sozlamalar ----
export const getSetting: typeof D.getSetting = async (key, fallback = '') => {
  if (key in session.settings) return session.settings[key]
  return rpc('getSetting', key, fallback)
}
export const setSetting: typeof D.setSetting = async (key, value) => {
  await rpc('setSetting', key, value)
  session.settings[key] = value
}

// ---- Kategoriyalar ----
export const listCategories: typeof D.listCategories = () => swr('categories', () => rpc('listCategories'))
export const saveCategory: typeof D.saveCategory = (name, id) => rpc('saveCategory', name, id ?? null)
export const deleteCategory: typeof D.deleteCategory = (id) => rpc('deleteCategory', id)

// ---- Mahsulotlar ----
export const listProducts: typeof D.listProducts = (activeOnly = true) => swr(`products:${activeOnly ? 1 : 0}`, () => rpc('listProducts', activeOnly))
export const saveProduct: typeof D.saveProduct = (p) => rpc('saveProduct', p)
export const findProductByBarcode: typeof D.findProductByBarcode = (code) => rpc('findProductByBarcode', code)
export const getProductWithCategory: typeof D.getProductWithCategory = (id) => rpc('getProductWithCategory', id)
export const setProductActive: typeof D.setProductActive = (id, active) => rpc('setProductActive', id, active)
export const deleteProduct: typeof D.deleteProduct = (id) => rpc('deleteProduct', id)
export const bulkPricePreview: typeof D.bulkPricePreview = (params, limit = 12) => rpc('bulkPricePreview', params, limit)
export const bulkAdjustPrices: typeof D.bulkAdjustPrices = (params) => rpc('bulkAdjustPrices', params)

// ---- Mijozlar ----
export const listCustomers: typeof D.listCustomers = (activeOnly = false) => swr(`customers:${activeOnly ? 1 : 0}`, () => rpc('listCustomers', activeOnly))
export const setCustomerActive: typeof D.setCustomerActive = (id, active) => rpc('setCustomerActive', id, active)
export const deleteCustomer: typeof D.deleteCustomer = (id) => rpc('deleteCustomer', id)
export const getCustomer: typeof D.getCustomer = (id) => rpc('getCustomer', id)
export const customerSales: typeof D.customerSales = (id) => rpc('customerSales', id)
export const customerPayments: typeof D.customerPayments = (id) => rpc('customerPayments', id)
export const recordCustomerPayment: typeof D.recordCustomerPayment = (customerId, amount, method, note) => rpc('recordCustomerPayment', customerId, amount, method, note ?? null)
export const saveCustomer: typeof D.saveCustomer = (name, phone, id) => rpc('saveCustomer', name, phone, id ?? null)
export const customerMovements: typeof D.customerMovements = (id) => rpc('customerMovements', id)
export const setCustomerBalance: typeof D.setCustomerBalance = (id, target) => rpc('setCustomerBalance', id, target)

// ---- Smena ----
export const activeShift: typeof D.activeShift = () => rpc('activeShift')
export const openShift: typeof D.openShift = (cash) => rpc('openShift', cash)
export const closeShift: typeof D.closeShift = (id, cash) => rpc('closeShift', id, cash)
export const listShifts: typeof D.listShifts = () => rpc('listShifts')
export const shiftStats: typeof D.shiftStats = (id) => rpc('shiftStats', id)

// ---- Sotuv ----
export const createSale: typeof D.createSale = (input) => rpc('createSale', {
  ...input,
  // Server nom/birlik/tannarxni o'zi oladi — faqat kerakli maydonlar.
  items: input.items.map((l) => ({ product_id: l.product_id, qty: l.qty, price: l.price })),
})
export const listSales: typeof D.listSales = (f = {}) => rpc('listSales', f)
export const listReturns: typeof D.listReturns = (f = {}) => rpc('listReturns', f)
export const customerReturns: typeof D.customerReturns = (id) => rpc('customerReturns', id)
export const productCustomerHistory: typeof D.productCustomerHistory = (pid, cid) => rpc('productCustomerHistory', pid, cid)

// ---- Xarajatlar ----
export const listExpenses: typeof D.listExpenses = (f = {}) => rpc('listExpenses', f)
export const saveExpense: typeof D.saveExpense = (e) => rpc('saveExpense', e)
export const deleteExpense: typeof D.deleteExpense = (id) => rpc('deleteExpense', id)
export const expensesTotal: typeof D.expensesTotal = (from, to) => rpc('expensesTotal', from, to)

// Desktop'dagi bilan bir xil (sof funksiya).
export function dayIso(date?: string): string {
  if (!date) return new Date().toISOString()
  const today = new Date().toISOString().slice(0, 10)
  if (date === today) return new Date().toISOString()
  return `${date}T12:00:00.000Z`
}
