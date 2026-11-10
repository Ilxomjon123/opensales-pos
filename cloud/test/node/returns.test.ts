import { describe, expect, it } from 'vitest'
import { allocate } from '../../src/shop/money'
import { splitRefunds } from '../../src/shop/ops/returnsCustomer'
import {
  balanceOf, countOf, customerSql, errCode, freshShop, openShiftSql, productSql, saleSql, stockOf, walkInId, type Shop,
} from './helpers'

// src-tauri/src/returns.rs va returns/customer.rs testlarining porti — bir xil holatlar,
// bir xil kutilgan qiymatlar. Parallel testlar o'rniga ketma-ket: DO so'rovlarni navbat bilan
// bajaradi, ikkinchisi birinchisi yozgan holatni ko'radi.

const lines = (items: [number, number][]) => items.map(([saleItemId, qty]) => ({ saleItemId, qty }))
const req = (saleId: number, items: [number, number][], cash: number, card: number, balance: number, reason: string | null = null) =>
  ({ request: { saleId, lines: lines(items), refundCash: cash, refundCard: card, refundBalance: balance, reason } })
const quote = (shop: Shop, saleId: number, items: [number, number][]) => shop.ok('return_quote', { saleId, lines: lines(items) })
const create = (shop: Shop, saleId: number, items: [number, number][], cash: number, card: number, balance: number, reason: string | null = null) =>
  shop.call('create_return', req(saleId, items, cash, card, balance, reason))

function setup() {
  const shop = freshShop()
  const shift = openShiftSql(shop)
  return { shop, shift, w: walkInId(shop) }
}

describe('returns by receipt (returns.rs)', () => {
  it('full return with discount refunds exact total and restores stock', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, 'Choy', 10_000, 10)
    const b = productSql(shop, 'Shakar', 3_333, 10)
    const [s, it] = saleSql(shop, shift, w, [[a, 10_000, 2], [b, 3_333, 3]], 999, 29_000)
    const q = quote(shop, s, [[it[0], 2], [it[1], 3]])
    expect(q).toMatchObject({ amount: 29_000, moneyCap: 29_000, suggestedBalance: 0, balanceAllowed: false, shiftOpen: true })
    const r = shop.ok('create_return', req(s, [[it[0], 2], [it[1], 3]], 29_000, 0, 0))
    expect(r.amount).toBe(29_000)
    expect(r.returnNumber).toBe(`${shift}-00001-V1`)
    expect(r.items.reduce((x: number, i: any) => x + i.subtotal, 0)).toBe(29_999)
    expect(stockOf(shop, a)).toBe(10)
    expect(stockOf(shop, b)).toBe(10)
    expect(r.createdAt).toMatch(/T.*Z$/)
  })

  it('partial returns add up exactly to sale total', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, 'Choy', 10_000, 10)
    const b = productSql(shop, 'Shakar', 3_333, 10)
    const [s, it] = saleSql(shop, shift, w, [[a, 10_000, 2], [b, 3_333, 3]], 999, 29_000)
    let refunded = 0
    for (const [item, qty] of [[it[1], 1], [it[1], 1], [it[0], 1], [it[1], 1], [it[0], 1]] as [number, number][]) {
      const q = quote(shop, s, [[item, qty]])
      const r = shop.ok('create_return', req(s, [[item, qty]], q.amount, 0, 0))
      expect(r.amount).toBe(q.amount)
      refunded += r.amount
    }
    expect(refunded).toBe(29_000)
    expect(countOf(shop, 'sale_returns')).toBe(5)
    expect(shop.sql.get<any>('SELECT return_number FROM sale_returns ORDER BY id DESC LIMIT 1').return_number).toMatch(/-V5$/)
  })

  it('over-return and repeat return are rejected without writes', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, 'Choy', 1_000, 5)
    const [s, it] = saleSql(shop, shift, w, [[a, 1_000, 2]], 0, 2_000)
    const e = create(shop, s, [[it[0], 3]], 3_000, 0, 0)
    expect(e).toMatchObject({ ok: false, error: { code: 'qtyExceeds', params: { max: 2 } } })
    expect(countOf(shop, 'sale_returns')).toBe(0)
    expect(stockOf(shop, a)).toBe(3)
    shop.ok('create_return', req(s, [[it[0], 2]], 2_000, 0, 0))
    expect(errCode(create(shop, s, [[it[0], 1]], 1_000, 0, 0))).toBe('alreadyReturned')
    expect(stockOf(shop, a)).toBe(5)
  })

  it('double return (two requests) succeeds only once', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, 'Choy', 1_000, 0)
    const [s, it] = saleSql(shop, shift, w, [[a, 1_000, 4]], 0, 4_000)
    const x = create(shop, s, [[it[0], 4]], 4_000, 0, 0)
    const y = create(shop, s, [[it[0], 4]], 4_000, 0, 0)
    expect([x.ok, y.ok]).toEqual([true, false])
    expect(errCode(y)).toBe('alreadyReturned')
    expect(stockOf(shop, a)).toBe(0)
    expect(countOf(shop, 'sale_returns')).toBe(1)
  })

  it('failure midway rolls back everything', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 1_000, 0)
    const boom = productSql(shop, 'BOOM', 1_000, 0)
    const [s, it] = saleSql(shop, shift, c, [[a, 1_000, 1], [boom, 1_000, 1]], 0, 0)
    expect(balanceOf(shop, c)).toBe(-2_000)
    shop.sql.script("CREATE TRIGGER boom BEFORE INSERT ON sale_return_items WHEN NEW.product_name = 'BOOM' BEGIN SELECT RAISE(ABORT, 'boom'); END")
    const e = create(shop, s, [[it[0], 1], [it[1], 1]], 0, 0, 2_000)
    expect(e).toMatchObject({ ok: false, error: { code: 'cloud.errors.internal' } })
    expect(countOf(shop, 'sale_returns')).toBe(0)
    expect(countOf(shop, 'sale_return_items')).toBe(0)
    expect(stockOf(shop, a)).toBe(-1)
    expect(balanceOf(shop, c)).toBe(-2_000)
  })

  it('walk-in cannot refund to balance', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, 'Choy', 1_000, 0)
    const [s, it] = saleSql(shop, shift, w, [[a, 1_000, 1]], 0, 1_000)
    expect(errCode(create(shop, s, [[it[0], 1]], 0, 0, 1_000))).toBe('walkInBalance')
    expect(create(shop, s, [[it[0], 1]], 0, 1_000, 0).ok).toBe(true)
  })

  it('debt sale goes to balance and cash is capped', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 25_000, 0)
    const [s, it] = saleSql(shop, shift, c, [[a, 25_000, 2]], 0, 0)
    expect(balanceOf(shop, c)).toBe(-50_000)
    const q = quote(shop, s, [[it[0], 2]])
    expect([q.amount, q.moneyCap, q.suggestedBalance]).toEqual([50_000, 0, 50_000])
    expect(create(shop, s, [[it[0], 2]], 50_000, 0, 0)).toMatchObject({ ok: false, error: { code: 'cashExceedsCap', params: { max: 0 } } })
    shop.ok('create_return', req(s, [[it[0], 2]], 0, 0, 50_000))
    expect(balanceOf(shop, c)).toBe(0)
  })

  it('partially paid sale closes its debt first', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 50_000, 0)
    const [s, it] = saleSql(shop, shift, c, [[a, 50_000, 2]], 0, 60_000)
    expect(balanceOf(shop, c)).toBe(-40_000)
    let q = quote(shop, s, [[it[0], 1]])
    expect([q.amount, q.moneyCap, q.suggestedBalance]).toEqual([50_000, 50_000, 40_000])
    shop.ok('create_return', req(s, [[it[0], 1]], 10_000, 0, 40_000))
    expect(balanceOf(shop, c)).toBe(0)
    q = quote(shop, s, [[it[0], 1]])
    expect([q.amount, q.moneyCap, q.suggestedBalance]).toEqual([50_000, 50_000, 0])
    shop.ok('create_return', req(s, [[it[0], 1]], 50_000, 0, 0))
    expect(shop.sql.get<any>('SELECT SUM(refund_cash) s FROM sale_returns').s).toBe(60_000)
  })

  it('debt paid later allows full cash refund', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 100_000, 0)
    const [s, it] = saleSql(shop, shift, c, [[a, 100_000, 1]], 0, 60_000)
    shop.sql.run('UPDATE customers SET balance = balance + 40000 WHERE id = ?', c)
    const q = quote(shop, s, [[it[0], 1]])
    expect([q.amount, q.moneyCap, q.suggestedBalance]).toEqual([100_000, 100_000, 0])
    shop.ok('create_return', req(s, [[it[0], 1]], 100_000, 0, 0))
    expect(balanceOf(shop, c)).toBe(0)
  })

  it('refund split must match amount', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 1_000, 0)
    const [s, it] = saleSql(shop, shift, c, [[a, 1_000, 2]], 0, 2_000)
    expect(create(shop, s, [[it[0], 1]], 999, 0, 0)).toMatchObject({ ok: false, error: { code: 'refundMismatch', params: { amount: 1_000 } } })
    expect(errCode(create(shop, s, [[it[0], 1]], 2_000, 0, -1_000))).toBe('refundNegative')
    expect(errCode(create(shop, s, [[it[0], 1]], Number.MAX_SAFE_INTEGER, 1, 0))).toBe('refundMismatch')
    expect(countOf(shop, 'sale_returns')).toBe(0)
  })

  it('invalid input is rejected with specific codes', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, 'Choy', 1_000, 0)
    const [s, it] = saleSql(shop, shift, w, [[a, 1_000, 2]], 0, 2_000)
    const [s2, it2] = saleSql(shop, shift, w, [[a, 1_000, 1]], 0, 1_000)
    const i = it[0]
    // NaN/Infinity JSON'da null bo'lib keladi.
    for (const bad of [0, -1, null, 'x', 0.0004]) {
      expect(errCode(shop.call('create_return', { request: { saleId: s, lines: [{ saleItemId: i, qty: bad }], refundCash: 0, refundCard: 0, refundBalance: 0 } }))).toBe('invalidQty')
    }
    expect(errCode(create(shop, s, [[it2[0], 1]], 1_000, 0, 0))).toBe('lineNotInSale')
    expect(errCode(create(shop, s, [[i, 1], [i, 1]], 2_000, 0, 0))).toBe('duplicateLine')
    expect(errCode(create(shop, s, [], 0, 0, 0))).toBe('noLines')
    expect(errCode(create(shop, 999_999, [[i, 1]], 1_000, 0, 0))).toBe('saleNotFound')
    expect(errCode(create(shop, s, [[i, 1]], 1_000, 0, 0, 'x'.repeat(501)))).toBe('reasonTooLong')
    expect(shop.ok('create_return', req(s2, [[it2[0], 1]], 1_000, 0, 0, '   ')).reason).toBeNull()
    expect(countOf(shop, 'sale_returns')).toBe(1)
  })

  it('return requires own open shift but quote does not', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, 'Choy', 1_000, 0)
    const [s, it] = saleSql(shop, shift, w, [[a, 1_000, 1]], 0, 1_000)
    shop.sql.run("UPDATE shifts SET status = 'closed'")
    const q = quote(shop, s, [[it[0], 1]])
    expect(q.shiftOpen).toBe(false)
    expect(q.amount).toBe(1_000)
    expect(errCode(create(shop, s, [[it[0], 1]], 1_000, 0, 0))).toBe('noShift')
    const shift2 = openShiftSql(shop)
    shop.ok('create_return', req(s, [[it[0], 1]], 1_000, 0, 0))
    expect(shop.sql.get<any>('SELECT shift_id FROM sale_returns').shift_id).toBe(shift2)
  })

  it('fractional quantities snap to remaining', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, 'Guruch', 12_000, 0)
    const [s, it] = saleSql(shop, shift, w, [[a, 12_000, 2.25]], 0, 27_000)
    expect(shop.ok('create_return', req(s, [[it[0], 1.5]], 18_000, 0, 0)).amount).toBe(18_000)
    const q = quote(shop, s, [])
    expect(Math.abs(q.lines[0].qtyRemaining - 0.75)).toBeLessThan(1e-9)
    expect(q.amount).toBe(0)
    expect(errCode(create(shop, s, [[it[0], 0.7515]], 9_000, 0, 0))).toBe('qtyExceeds')
    const r = shop.ok('create_return', req(s, [[it[0], 0.7504]], 9_000, 0, 0))
    expect(r.amount).toBe(9_000)
    expect(Math.abs(r.items[0].qty - 0.75)).toBeLessThan(1e-9)
    expect(Math.abs(stockOf(shop, a))).toBeLessThan(1e-9)
  })

  it('fully discounted sale returns goods with zero refund', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, "Sovg'a", 5_000, 0)
    const [s, it] = saleSql(shop, shift, w, [[a, 5_000, 1]], 5_000, 0)
    expect(shop.ok('create_return', req(s, [[it[0], 1]], 0, 0, 0)).amount).toBe(0)
    expect(stockOf(shop, a)).toBe(0)
  })

  it('legacy fractional values in integer columns are handled', () => {
    const { shop, shift, w } = setup()
    const a = productSql(shop, 'Choy', 17_225, 0)
    const [s, it] = saleSql(shop, shift, w, [[a, 17_225, 1]], 0, 17_225)
    shop.sql.run('UPDATE sale_items SET cost_price = 12527.2 WHERE id = ?', it[0])
    shop.sql.run('UPDATE sales SET paid_cash = 17225.4, paid_amount = 17225.4 WHERE id = ?', s)
    expect(quote(shop, s, [[it[0], 1]]).amount).toBe(17_225)
    shop.ok('create_return', req(s, [[it[0], 1]], 17_225, 0, 0))
    expect(shop.sql.get<any>('SELECT cost_price FROM sale_return_items').cost_price).toBeCloseTo(12527.2, 9)
  })

  it('cashier cannot return (owner-only op)', () => {
    const shop = freshShop({ withCashier: true })
    expect(shop.call('return_quote', { saleId: 1, lines: [] }, { uid: 2002, name: 'Kassir', role: 'cashier' })).toMatchObject({ ok: false, error: { status: 403 } })
  })

  it('allocate rounds half up and hits total exactly', () => {
    expect(allocate(29_000, 29_999, 29_999)).toBe(29_000)
    expect(allocate(29_000, 3_333, 29_999)).toBe(3_222)
    expect(allocate(3, 1, 2)).toBe(2)
    expect(allocate(100, 0, 10)).toBe(0)
    expect(allocate(100, 5, 0)).toBe(0)
    // Katta qiymatlarda ham aniq (BigInt).
    expect(allocate(9_000_000_000_000, 4_999_999_999_999, 9_999_999_999_999)).toBe(4_500_000_000_000)
  })
})

// ---------------------------------------------------------------------------
const pq = (items: [number, number][]) => items.map(([productId, qty]) => ({ productId, qty }))
const cquote = (shop: Shop, customerId: number, items: [number, number][]) => shop.call('customer_return_quote', { customerId, lines: pq(items) })
const ccreate = (shop: Shop, customerId: number, items: [number, number][], cash: number, card: number, bal: number) =>
  shop.call('create_customer_return', { request: { customerId, lines: pq(items), refundCash: cash, refundCard: card, refundBalance: bal, reason: null } })

describe('returns by customer (returns/customer.rs)', () => {
  it('allocates newest receipt first across sales', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 1_000, 0)
    const [s1] = saleSql(shop, shift, c, [[a, 1_000, 3]], 0, 3_000)
    const [s2] = saleSql(shop, shift, c, [[a, 1_200, 2]], 0, 2_400)
    const q = (cquote(shop, c, [[a, 4]]) as any).data
    expect(q.allocations.map((x: any) => x.saleId)).toEqual([s2, s1])
    expect(q.allocations[0].lines[0].qty).toBe(2)
    expect(q.allocations[1].lines[0].qty).toBe(2)
    expect(q.amount).toBe(2_400 + 2_000)
    expect(q.products[0]).toMatchObject({ qtyRemaining: 5, lastPrice: 1_200 })
    const r = (ccreate(shop, c, [[a, 4]], 4_400, 0, 0) as any).data
    expect(r.returns).toHaveLength(2)
    expect(r.amount).toBe(4_400)
    expect(stockOf(shop, a)).toBe(-1)
    const q2 = (cquote(shop, c, []) as any).data
    expect(q2.products[0].qtyRemaining).toBe(1)
    expect(q2.allocations).toEqual([])
  })

  it('respects returns already made by receipt', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 1_000, 0)
    const [, it1] = saleSql(shop, shift, c, [[a, 1_000, 2]], 0, 2_000)
    const [s2, it2] = saleSql(shop, shift, c, [[a, 1_000, 2]], 0, 2_000)
    shop.ok('create_return', req(s2, [[it2[0], 2]], 2_000, 0, 0))
    expect(ccreate(shop, c, [[a, 3]], 3_000, 0, 0)).toMatchObject({ ok: false, error: { code: 'qtyExceeds', params: { max: 2 } } })
    const q = (cquote(shop, c, [[a, 2]]) as any).data
    expect(q.allocations).toHaveLength(1)
    expect(q.allocations[0].lines[0].saleItemId).toBe(it1[0])
  })

  it('rejects walk-in, unknown customer and unbought product', () => {
    const { shop, shift, w } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 1_000, 0)
    const b = productSql(shop, 'Shakar', 1_000, 0)
    saleSql(shop, shift, w, [[a, 1_000, 1]], 0, 1_000)
    saleSql(shop, shift, c, [[a, 1_000, 1]], 0, 1_000)
    expect(errCode(cquote(shop, w, []))).toBe('walkInNeedsReceipt')
    expect(errCode(cquote(shop, 999_999, []))).toBe('customerNotFound')
    expect(errCode(cquote(shop, c, [[b, 1]]))).toBe('productNotBought')
    expect(errCode(cquote(shop, c, [[a, 1], [a, 1]]))).toBe('duplicateLine')
    expect(errCode(shop.call('customer_return_quote', { customerId: c, lines: [{ productId: a, qty: null }] }))).toBe('invalidQty')
    expect(errCode(ccreate(shop, c, [], 0, 0, 0))).toBe('noLines')
    expect(countOf(shop, 'sale_returns')).toBe(0)
  })

  it('debt is closed first and split spreads over receipts', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 10_000, 0)
    const [s1] = saleSql(shop, shift, c, [[a, 10_000, 1]], 0, 10_000)
    const [s2] = saleSql(shop, shift, c, [[a, 10_000, 1]], 0, 0)
    expect(balanceOf(shop, c)).toBe(-10_000)
    const q = (cquote(shop, c, [[a, 2]]) as any).data
    expect([q.amount, q.moneyCap, q.balanceMin, q.suggestedBalance]).toEqual([20_000, 10_000, 10_000, 10_000])
    expect(ccreate(shop, c, [[a, 2]], 20_000, 0, 0)).toMatchObject({ ok: false, error: { code: 'cashExceedsCap', params: { max: 10_000 } } })
    const r = (ccreate(shop, c, [[a, 2]], 0, 10_000, 10_000) as any).data
    expect(balanceOf(shop, c)).toBe(0)
    const bySale = (sid: number) => r.returns.find((x: any) => x.saleId === sid)
    expect([bySale(s2).refundBalance, bySale(s2).refundCard]).toEqual([10_000, 0])
    expect([bySale(s1).refundBalance, bySale(s1).refundCard]).toEqual([0, 10_000])
  })

  it('failure on one receipt rolls back all', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 1_000, 0)
    saleSql(shop, shift, c, [[a, 1_000, 1]], 0, 1_000)
    const [s2] = saleSql(shop, shift, c, [[a, 1_000, 1]], 0, 1_000)
    shop.sql.script(`CREATE TRIGGER boom BEFORE INSERT ON sale_returns WHEN NEW.sale_id <> ${s2} BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    expect(ccreate(shop, c, [[a, 2]], 2_000, 0, 0).ok).toBe(false)
    expect(countOf(shop, 'sale_returns')).toBe(0)
    expect(countOf(shop, 'sale_return_items')).toBe(0)
    expect(stockOf(shop, a)).toBe(-2)
  })

  it('two customer returns cannot exceed remaining', () => {
    const { shop, shift } = setup()
    const c = customerSql(shop)
    const a = productSql(shop, 'Choy', 1_000, 0)
    saleSql(shop, shift, c, [[a, 1_000, 2]], 0, 2_000)
    saleSql(shop, shift, c, [[a, 1_000, 1]], 0, 1_000)
    const x = ccreate(shop, c, [[a, 2]], 2_000, 0, 0)
    const y = ccreate(shop, c, [[a, 2]], 2_000, 0, 0)
    expect([x.ok, y.ok]).toEqual([true, false])
    expect(errCode(y)).toBe('qtyExceeds')
    expect(stockOf(shop, a)).toBe(-1)
  })

  it('split respects each receipt bounds', () => {
    const alloc = (amount: number, moneyCap: number, suggestedBalance: number) => ({ amount, moneyCap, suggestedBalance })
    const a = [alloc(10_000, 0, 10_000), alloc(10_000, 10_000, 0), alloc(5_000, 5_000, 0)]
    const s = splitRefunds(a, 3_000, 10_000, 12_000)
    expect(s).toEqual([[0, 0, 10_000], [0, 8_000, 2_000], [3_000, 2_000, 0]])
    s.forEach(([cash, card, bal], k) => {
      expect(cash + card + bal).toBe(a[k].amount)
      expect(cash + card).toBeLessThanOrEqual(a[k].moneyCap)
    })
    expect(() => splitRefunds(a, 25_000, 0, 0)).toThrow('cashExceedsCap')
    expect(() => splitRefunds(a, 1, 0, 0)).toThrow('refundMismatch')
    expect(() => splitRefunds(a, -1, 0, 25_001)).toThrow('refundNegative')
    expect(splitRefunds([], 0, 0, 0)).toEqual([])
  })
})
