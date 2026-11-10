import { describe, expect, it } from 'vitest'
import { weightedCost } from '../../src/shop/ops/stock'
import { countOf, customerSql, errCode, freshShop, openShiftSql, productSql, saleSql, stockOf, type Shop } from './helpers'

// src-tauri/src/stock.rs testlarining porti.

type Line = { productId: number; qty: unknown; costPrice: unknown; salePrice: unknown }
const line = (productId: number, qty: unknown, costPrice: unknown, salePrice: unknown = null): Line => ({ productId, qty, costPrice, salePrice })
const receipt = (lines: Line[], extra: Record<string, unknown> = {}) => ({ request: { supplier: '  Ulgurji baza ', note: null, receivedAt: null, lines, ...extra } })
const cost = (shop: Shop, pid: number) => shop.sql.get<{ c: number }>('SELECT CAST(cost_price AS REAL) c FROM products WHERE id = ?', pid)!.c
const price = (shop: Shop, pid: number) => shop.sql.get<{ p: number }>('SELECT CAST(price AS REAL) p FROM products WHERE id = ?', pid)!.p
const create = (shop: Shop, lines: Line[], extra: Record<string, unknown> = {}) => shop.call('create_stock_receipt', receipt(lines, extra))
const voidR = (shop: Shop, receiptId: number, reason: string | null = null) => shop.call('void_stock_receipt', { receiptId, reason })
const adjust = (shop: Shop, productId: number, newStock: unknown, kind: string, note: string | null = null) => shop.call('adjust_product_stock', { productId, newStock, kind, note })

describe('stock receipts (stock.rs)', () => {
  it('receipt adds stock, averages cost and updates price', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, 10)
    const b = productSql(shop, 'Shakar', 4_000, 0)
    const r = (create(shop, [line(a, 10, 7_000, 12_000), line(b, 2.5, 3_000)]) as any).data
    expect(r.receiptNumber).toBe(`K-${String(r.id).padStart(5, '0')}`)
    expect(r.total).toBe(70_000 + 7_500)
    expect(r.lines).toBe(2)
    expect(stockOf(shop, a)).toBe(20)
    expect(stockOf(shop, b)).toBe(2.5)
    expect(cost(shop, a)).toBe(6_000)
    expect(cost(shop, b)).toBe(3_000)
    expect(price(shop, a)).toBe(12_000)
    expect(price(shop, b)).toBe(4_000)
    expect(shop.sql.get<any>('SELECT supplier, user_id FROM stock_receipts')).toEqual({ supplier: 'Ulgurji baza', user_id: 1001 })
  })

  it('zero incoming cost keeps cost; unknown old cost takes incoming', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, 10)
    const b = shop.sql.get<{ id: number }>("INSERT INTO products(name, price, cost_price, stock) VALUES('Un', 9000, 0, 50) RETURNING id")!.id
    expect(create(shop, [line(a, 5, 0), line(b, 10, 6_000)]).ok).toBe(true)
    expect(cost(shop, a)).toBe(5_000)
    expect(stockOf(shop, a)).toBe(15)
    expect(cost(shop, b)).toBe(6_000)
  })

  it('negative stock is not averaged against', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, -4)
    create(shop, [line(a, 10, 8_000)])
    expect(stockOf(shop, a)).toBe(6)
    expect(cost(shop, a)).toBe(8_000)
  })

  it('invalid receipts are rejected without writes', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, 10)
    const b = productSql(shop, 'Shakar', 4_000, 10)
    expect(errCode(create(shop, []))).toBe('noLines')
    expect(errCode(create(shop, [line(a, 1, 1), line(a, 2, 1)]))).toBe('duplicateLine')
    expect(errCode(create(shop, [line(a, 0, 1)]))).toBe('invalidQty')
    expect(errCode(create(shop, [line(a, 0.0001, 1)]))).toBe('invalidQty')
    expect(errCode(create(shop, [line(a, null, 1)]))).toBe('invalidQty')
    expect(errCode(create(shop, [line(a, 1, -5)]))).toBe('invalidCost')
    expect(errCode(create(shop, [line(a, 1, null)]))).toBe('invalidCost')
    expect(errCode(create(shop, [line(a, 1, 1, -1)]))).toBe('invalidPrice')
    expect(errCode(create(shop, [line(9_999, 1, 1)]))).toBe('productNotFound')
    expect(errCode(create(shop, [line(a, 1, 1)], { supplier: 'x'.repeat(121) }))).toBe('supplierTooLong')
    expect(errCode(create(shop, [line(a, 1, 1)], { receivedAt: '29-10-2026' }))).toBe('invalidDate')
    expect(errCode(create(shop, [line(a, 1, 1)], { receivedAt: '2999-01-01T12:00:00.000Z' }))).toBe('futureDate')
    expect(errCode(create(shop, [line(b, 3, 1), line(a, -1, 1)]))).toBe('invalidQty')
    expect(countOf(shop, 'stock_receipts')).toBe(0)
    expect(countOf(shop, 'stock_receipt_items')).toBe(0)
    expect(stockOf(shop, a)).toBe(10)
    expect(stockOf(shop, b)).toBe(10)
  })

  it('backdated receipt keeps chosen day', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, 0)
    expect((create(shop, [line(a, 1, 1)], { receivedAt: '2026-01-15T12:00:00.000Z' }) as any).data.receivedAt).toBe('2026-01-15T12:00:00.000Z')
  })

  it('void restores stock, cost and price', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, 10)
    const r = (create(shop, [line(a, 10, 70_000, 90_000)]) as any).data
    expect(cost(shop, a)).toBe(37_500)
    const v = (voidR(shop, r.id, 'xato narx') as any).data
    expect(v.receiptNumber).toBe(r.receiptNumber)
    expect(stockOf(shop, a)).toBe(10)
    expect(cost(shop, a)).toBe(5_000)
    expect(price(shop, a)).toBe(10_000)
    expect(errCode(voidR(shop, r.id))).toBe('alreadyVoided')
    expect(errCode(voidR(shop, 9_999))).toBe('receiptNotFound')
  })

  it('void keeps cost changed after the receipt', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, 10)
    const first = (create(shop, [line(a, 10, 7_000)]) as any).data
    create(shop, [line(a, 20, 9_000)])
    const afterSecond = cost(shop, a)
    voidR(shop, first.id)
    expect(stockOf(shop, a)).toBe(30)
    expect(cost(shop, a)).toBe(afterSecond)
    const b = productSql(shop, 'Shakar', 4_000, 0)
    const r = (create(shop, [line(b, 5, 3_000, 5_000)]) as any).data
    shop.sql.run('UPDATE products SET price = 5500 WHERE id = ?', b)
    voidR(shop, r.id)
    expect(price(shop, b)).toBe(5_500)
  })

  it('void is refused when goods already sold unless negative allowed', () => {
    const shop = freshShop()
    const shift = openShiftSql(shop)
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 10_000, 0)
    const r = (create(shop, [line(a, 10, 7_000)]) as any).data
    saleSql(shop, shift, c, [[a, 10_000, 4]], 0, 40_000)
    expect(voidR(shop, r.id)).toMatchObject({ ok: false, error: { code: 'stockWouldGoNegative', params: { stock: 6 } } })
    expect(stockOf(shop, a)).toBe(6)
    expect(shop.sql.get<any>('SELECT voided_at FROM stock_receipts').voided_at).toBeNull()
    shop.sql.run("INSERT INTO settings(key, value) VALUES('allow_negative_stock', '1')")
    expect(voidR(shop, r.id).ok).toBe(true)
    expect(stockOf(shop, a)).toBe(-4)
  })

  it('double void succeeds only once', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, 0)
    const r = (create(shop, [line(a, 10, 7_000)]) as any).data
    const results = [voidR(shop, r.id), voidR(shop, r.id)]
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    expect(errCode(results[1])).toBe('alreadyVoided')
    expect(stockOf(shop, a)).toBe(0)
  })

  it('adjustment records delta and skips no change', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, 10)
    const out = (adjust(shop, a, 7.5, 'manual', ' sanaldi ') as any).data
    expect(out).toMatchObject({ recorded: true, qtyBefore: 10, qtyAfter: 7.5, delta: -2.5 })
    expect(stockOf(shop, a)).toBe(7.5)
    expect(shop.sql.get<any>('SELECT delta, kind, note FROM stock_adjustments')).toEqual({ delta: -2.5, kind: 'manual', note: 'sanaldi' })
    expect((adjust(shop, a, 7.5, 'manual') as any).data.recorded).toBe(false)
    expect(countOf(shop, 'stock_adjustments')).toBe(1)
    expect(errCode(adjust(shop, a, -1, 'manual'))).toBe('invalidStock')
    expect(errCode(adjust(shop, a, null, 'manual'))).toBe('invalidStock')
    expect(errCode(adjust(shop, a, 1, 'drop table'))).toBe('invalidKind')
    expect(errCode(adjust(shop, 9_999, 1, 'manual'))).toBe('productNotFound')
    expect(stockOf(shop, a)).toBe(7.5)
  })

  it('weighted cost rules', () => {
    expect(weightedCost(10, 5_000, 10, 7_000)).toBe(6_000)
    expect(weightedCost(0, 5_000, 10, 7_000)).toBe(7_000)
    expect(weightedCost(10, 0, 10, 7_000)).toBe(7_000)
    expect(weightedCost(10, 5_000, 10, 0)).toBe(5_000)
    expect(weightedCost(3, 12_527.2, 1, 13_000)).toBe(12_645)
  })

  it('cashier cannot touch stock', () => {
    const shop = freshShop({ withCashier: true })
    const a = productSql(shop, 'Choy', 10_000, 10)
    expect(shop.call('adjust_product_stock', { productId: a, newStock: 1, kind: 'manual' }, { uid: 2002, name: 'K', role: 'cashier' })).toMatchObject({ ok: false, error: { status: 403 } })
  })

  it('stock journal feeds the movement report (receipt + void + adjust)', () => {
    const shop = freshShop()
    const a = productSql(shop, 'Choy', 10_000, 0)
    create(shop, [line(a, 10, 7_000)])
    const r2 = (create(shop, [line(a, 5, 7_000)]) as any).data
    voidR(shop, r2.id)
    adjust(shop, a, 8, 'manual', 'sindi')
    const day = new Date().toISOString().slice(0, 10)
    const row = shop.ok<any[]>('stockMovementReport', [day, day])[0]
    expect(row).toMatchObject({ opening: 0, income: 10, outcome: 2, closing: 8 })
    expect(shop.ok<any[]>('productMoves', [a, 'Mijoz']).map((m) => m.kind)).toEqual(['receipt', 'adjust'])
  })
})
