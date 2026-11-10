import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { setParityDatabase } from './shims/plugin-sql'
import { nodeSql } from '../../src/shop/sql'
import { migrate } from '../../src/shop/schema'
import { initShop } from '../../src/shop/init'
import { freshShop, OWNER, type Shop } from './helpers'
import * as D from '../../../src/lib/db'
import * as DR from '../../../src/lib/reports'
import * as DS from '../../../src/lib/stock'
import { t } from '../../../src/lib/i18n'

// Paritet: bir xil amallar desktop src/lib/*.ts funksiyalarida (node:sqlite ustida, Tauri
// plaginlari shim) va bulut op'larida bajariladi — natijalar bir xil bo'lishi SHART.
// Bulutga xos maydonlar (user_id, user_name) solishtirishdan oldin olib tashlanadi.

function strip<T>(x: T): T {
  if (Array.isArray(x)) return x.map(strip) as T
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
      if (k === 'user_id' || k === 'user_name') continue
      out[k] = strip(val)
    }
    return out as T
  }
  return x
}

let desktopDb: DatabaseSync
let cloud: Shop
let clock = Date.parse('2026-11-05T09:00:00.000Z')
const tick = (ms = 60_000) => { clock += ms; vi.setSystemTime(clock) }

// Ikkala tomonda bir xil yozuv (Rust buyruqlari — kirim/tuzatish — paritetda yo'q, shuning
// uchun ularning jurnal yozuvlari ikkala bazaga bir xil SQL bilan qo'yiladi).
function bothSql(q: string, ...p: (string | number | null)[]) {
  desktopDb.prepare(q).run(...p)
  cloud.sql.run(q, ...p)
}

async function both<T>(desktop: () => Promise<T>, op: string, args: unknown[]): Promise<{ d: T; c: T }> {
  const d = await desktop()
  const c = cloud.ok<T>(op, args)
  return { d, c }
}

async function same(desktop: () => Promise<unknown>, op: string, args: unknown[] = []) {
  const { d, c } = await both(desktop, op, args)
  expect(strip(c)).toEqual(strip(d))
  return c
}

const ids = { cat1: 0, cat2: 0, cola: 0, non: 0, suv: 0, ali: 0, vali: 0, walkIn: 0, shift: 0 }

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
  // Desktop sqlx SQLite qo'sh tirnoqli satrga ruxsat beradi (openShift `"open"`) — shu yerda ham.
  desktopDb = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: true })
  const dsql = nodeSql(desktopDb)
  migrate(dsql)
  initShop(dsql, {
    tenantId: 't_parity', shopName: 'P', owner: { uid: OWNER.uid, name: OWNER.name },
    subscription: { trialUntil: '2999-01-01T00:00:00.000Z', paidUntil: null, status: 'active' },
  }, new Date().toISOString())
  setParityDatabase(desktopDb)
  cloud = freshShop()
  await D.db() // seedIfEmpty + healSchema desktop'da
  ids.walkIn = cloud.sql.get<{ id: number }>('SELECT id FROM customers WHERE is_walk_in = 1')!.id

  // ---- Bir xil ma'lumot, ikkala API orqali ----
  await D.saveCategory('Ichimliklar'); cloud.ok('saveCategory', ['Ichimliklar'])
  await D.saveCategory('Non'); cloud.ok('saveCategory', ['Non'])
  ids.cat1 = 1; ids.cat2 = 2
  const products = [
    { name: 'Coca-Cola 1.5L', price: 14000, cost_price: 11000, unit: 'dona', category_id: 1, barcode: '5449000000996', barcode_type: 'EAN_13' },
    { name: 'Non', price: 4000, cost_price: 3000, unit: 'dona', category_id: 2, barcode: null },
    { name: 'Suv 19L', price: 15000, cost_price: 9000, unit: 'dona', category_id: 1, barcode: '4780000000123' },
  ]
  for (const p of products) {
    const d = await D.saveProduct(p as never)
    const c = cloud.ok<number>('saveProduct', [p])
    expect(c).toBe(d)
  }
  ids.cola = 1; ids.non = 2; ids.suv = 3
  bothSql('UPDATE products SET stock = 50 WHERE id = 1')
  bothSql('UPDATE products SET stock = 12.5 WHERE id = 2')
  bothSql('UPDATE products SET stock = 30 WHERE id = 3')
  ids.ali = await D.saveCustomer("Ali do'kon", '+998901112233'); cloud.ok('saveCustomer', ["Ali do'kon", '+998901112233'])
  ids.vali = await D.saveCustomer('Vali', null); cloud.ok('saveCustomer', ['Vali', null])

  tick()
  const ds = await D.openShift(100000)
  const cs = cloud.ok('openShift', [100000])
  expect(strip(cs)).toEqual(strip(ds))
  ids.shift = ds.id

  const sales: D.CreateSaleInput[] = [
    { shiftId: ids.shift, customerId: ids.walkIn, items: [{ product_id: 1, name: 'Coca-Cola 1.5L', unit: 'dona', price: 14000, cost_price: 11000, qty: 2, stock: 50 }], paidCash: 30000, paidCard: 0, discount: 0 },
    { shiftId: ids.shift, customerId: ids.ali, items: [{ product_id: 3, name: 'Suv 19L', unit: 'dona', price: 15000, cost_price: 9000, qty: 4, stock: 30 }, { product_id: 2, name: 'Non', unit: 'dona', price: 4000, cost_price: 3000, qty: 1.5, stock: 12.5 }], paidCash: 20000, paidCard: 10000, discount: 2000 },
    { shiftId: ids.shift, customerId: ids.vali, items: [{ product_id: 3, name: 'Suv 19L', unit: 'dona', price: 15000, cost_price: 9000, qty: 2, stock: 26 }], paidCash: 0, paidCard: 0, discount: 0 },
    { shiftId: ids.shift, customerId: ids.walkIn, items: [{ product_id: 2, name: 'Non', unit: 'dona', price: 4000, cost_price: 3000, qty: 3, stock: 11 }], paidCash: 0, paidCard: 12000, discount: 500 },
  ]
  for (const s of sales) {
    tick()
    const d = await D.createSale(s)
    const c = cloud.ok('createSale', [s])
    expect(strip(c)).toEqual(strip(d))
  }
  tick()
  await D.recordCustomerPayment(ids.ali, 15000, 'cash'); cloud.ok('recordCustomerPayment', [ids.ali, 15000, 'cash'])
  await D.recordCustomerPayment(ids.vali, 10000, 'card', 'karta'); cloud.ok('recordCustomerPayment', [ids.vali, 10000, 'card', 'karta'])
  await D.setCustomerBalance(ids.vali, -50000); cloud.ok('setCustomerBalance', [ids.vali, -50000])
  tick()
  await D.saveExpense({ amount: 25000, category: 'Ijara', note: 'noyabr' }); cloud.ok('saveExpense', [{ amount: 25000, category: 'Ijara', note: 'noyabr' }])
  await D.saveExpense({ amount: 7000, category: '', date: '2026-11-01' }); cloud.ok('saveExpense', [{ amount: 7000, category: '', date: '2026-11-01' }])

  // Jurnal: kirim (bekor qilinmagan + bekor qilingan) va qo'lda tuzatish.
  bothSql("INSERT INTO stock_receipts(receipt_number, supplier, note, total, received_at, created_at) VALUES('K-00001', 'Coca-Cola Uz', 'birinchi', 110000, '2026-11-04T12:00:00.000Z', '2026-11-04T12:00:00.000Z')")
  bothSql("INSERT INTO stock_receipt_items(receipt_id, product_id, product_name, unit, qty, cost_price, subtotal, cost_before, cost_after, sale_price) VALUES(1, 1, 'Coca-Cola 1.5L', 'dona', 10, 11000, 110000, 11000, 11000, NULL)")
  bothSql("INSERT INTO stock_receipts(receipt_number, supplier, total, received_at, created_at, voided_at, void_reason) VALUES('K-00002', 'Bekor', 5000, '2026-11-04T13:00:00.000Z', '2026-11-04T13:00:00.000Z', '2026-11-04T14:00:00.000Z', 'xato')")
  bothSql("INSERT INTO stock_receipt_items(receipt_id, product_id, product_name, unit, qty, cost_price, subtotal) VALUES(2, 2, 'Non', 'dona', 5, 1000, 5000)")
  bothSql("INSERT INTO stock_adjustments(product_id, product_name, unit, qty_before, qty_after, delta, kind, note, created_at) VALUES(2, 'Non', 'dona', 8, 7.5, -0.5, 'manual', 'sindi', '2026-11-05T10:30:00.000Z')")
})

afterAll(() => { vi.useRealTimers() })

describe('desktop ↔ cloud parity', () => {
  it('catalog', async () => {
    await same(() => D.listCategories(), 'listCategories')
    await same(() => D.listProducts(), 'listProducts', [])
    await same(() => D.listProducts(false), 'listProducts', [false])
    await same(() => D.findProductByBarcode('5449000000996'), 'findProductByBarcode', ['5449000000996'])
    await same(() => D.findProductByBarcode('nope'), 'findProductByBarcode', ['nope'])
    await same(() => D.getProductWithCategory(2), 'getProductWithCategory', [2])
    await same(() => D.bulkPricePreview({ scope: 'category', categoryId: 1, mode: 'percent', direction: 'up', value: 7 }), 'bulkPricePreview', [{ scope: 'category', categoryId: 1, mode: 'percent', direction: 'up', value: 7 }])
  })

  it('customers', async () => {
    await same(() => D.listCustomers(), 'listCustomers', [])
    await same(() => D.listCustomers(true), 'listCustomers', [true])
    for (const id of [ids.ali, ids.vali, ids.walkIn]) {
      await same(() => D.getCustomer(id), 'getCustomer', [id])
      await same(() => D.customerSales(id), 'customerSales', [id])
      await same(() => D.customerPayments(id), 'customerPayments', [id])
      await same(() => D.customerMovements(id), 'customerMovements', [id])
      await same(() => D.customerReturns(id), 'customerReturns', [id])
    }
    await same(() => D.productCustomerHistory(3, ids.ali), 'productCustomerHistory', [3, ids.ali])
  })

  it('shift', async () => {
    await same(() => D.activeShift(), 'activeShift')
    await same(() => D.shiftStats(ids.shift), 'shiftStats', [ids.shift])
    await same(() => D.listShifts(), 'listShifts')
  })

  it('sales history (filters)', async () => {
    const filters: D.SalesFilter[] = [
      {}, { paymentStatus: 'debt' }, { paymentStatus: 'partial' }, { customerId: ids.ali }, { productId: 2 },
      { search: '-0000' }, { dateFrom: '2026-11-05', dateTo: '2026-11-05' }, { dateFrom: '2026-11-06' }, { returnedOnly: true },
    ]
    for (const f of filters) await same(() => D.listSales(f), 'listSales', [f])
    // Bo'sh ro'yxatlar "teng" bo'lib qolmasin — ma'lumot haqiqatan bor.
    const all = cloud.ok<any[]>('listSales', [{}])
    expect(all).toHaveLength(4)
    expect(all.flatMap((s) => s.items)).toHaveLength(5)
    expect(cloud.ok<any[]>('listSales', [{ paymentStatus: 'debt' }])).toHaveLength(1)
    await same(() => D.listReturns({}), 'listReturns', [{}])
  })

  it('expenses and reports', async () => {
    await same(() => D.listExpenses({}), 'listExpenses', [{}])
    await same(() => D.listExpenses({ category: 'Ijara' }), 'listExpenses', [{ category: 'Ijara' }])
    await same(() => D.expensesTotal('2026-11-01', '2026-11-30'), 'expensesTotal', ['2026-11-01', '2026-11-30'])
    await same(() => DR.firstSaleDate(), 'firstSaleDate')
    const rep = await same(() => DR.reportSummary('2026-11-01', '2026-11-30'), 'reportSummary', ['2026-11-01', '2026-11-30']) as any
    expect(rep.period.count).toBe(4)
    expect(rep.period.profit).toBeGreaterThan(0)
    expect(rep.topProducts.length).toBe(3)
    await same(() => DR.reportSummary('2026-10-01', '2026-10-31'), 'reportSummary', ['2026-10-01', '2026-10-31'])
  })

  it('stock journal reports', async () => {
    await same(() => DS.listStockReceipts({}), 'listStockReceipts', [{}])
    await same(() => DS.listStockReceipts({ status: 'voided' }), 'listStockReceipts', [{ status: 'voided' }])
    await same(() => DS.listStockReceipts({ productId: 1, dateFrom: '2026-11-01' }), 'listStockReceipts', [{ productId: 1, dateFrom: '2026-11-01' }])
    await same(() => DS.receiptSuppliers(), 'receiptSuppliers')
    await same(() => DS.stockMovementReport('2026-11-01', '2026-11-30'), 'stockMovementReport', ['2026-11-01', '2026-11-30'])
    await same(() => DS.stockMovementReport('2026-11-05', '2026-11-05'), 'stockMovementReport', ['2026-11-05', '2026-11-05'])
    for (const pid of [1, 2, 3]) await same(() => DS.productMoves(pid, 'Mijoz'), 'productMoves', [pid, 'Mijoz'])
    const moves = cloud.ok<any[]>('productMoves', [2, 'Mijoz'])
    expect(moves.map((m) => m.kind).sort()).toEqual(['adjust', 'sale', 'sale'])
    expect(cloud.ok<any[]>('stockMovementReport', ['2026-11-01', '2026-11-30']).length).toBe(3)
  })

  it('domain error messages translate to the same text', async () => {
    const r = cloud.call('deleteCategory', [1])
    expect(r.ok).toBe(false)
    const err = (r as { error: { code: string; params: Record<string, unknown> } }).error
    await expect(D.deleteCategory(1)).rejects.toThrow(t(err.code, err.params))
    const r2 = cloud.call('saveProduct', [{ name: 'Dup', price: 1, barcode: '5449000000996' }])
    const e2 = (r2 as { error: { code: string; params: Record<string, unknown> } }).error
    await expect(D.saveProduct({ name: 'Dup', price: 1, barcode: '5449000000996' })).rejects.toThrow(t(e2.code, e2.params))
  })

  it('writes after reads stay in sync (bulk price, close shift)', async () => {
    const p = { scope: 'all', mode: 'amount', direction: 'down', value: 1000 } as const
    await same(() => D.bulkAdjustPrices(p), 'bulkAdjustPrices', [p])
    await same(() => D.listProducts(false), 'listProducts', [false])
    tick()
    await D.closeShift(ids.shift, 150000); cloud.ok('closeShift', [ids.shift, 150000])
    await same(() => D.listShifts(), 'listShifts')
    await same(() => D.activeShift(), 'activeShift')
  })
})
