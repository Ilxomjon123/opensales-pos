import { describe, expect, it } from 'vitest'
import { CASHIER, OWNER, freshShop, line, seedProduct, walkInId } from './helpers'

describe('dispatcher', () => {
  it('rejects unknown ops and revoked members', () => {
    const shop = freshShop()
    expect(shop.call('dropEverything')).toMatchObject({ ok: false, error: { code: 'cloud.errors.unknownOp', status: 404 } })
    expect(shop.call('__proto__')).toMatchObject({ ok: false, error: { status: 404 } })
    // A'zo emas (yoki o'chirilgan) — token to'g'ri bo'lsa ham 403.
    expect(shop.call('listProducts', [], { uid: 999, name: 'x', role: 'owner' })).toMatchObject({ ok: false, error: { code: 'cloud.errors.memberRevoked', status: 403 } })
  })

  it('uses the role from members, not from the token', () => {
    const shop = freshShop({ withCashier: true })
    // Kassir tokenni "owner" deb soxtalashtirsa ham — egasi op'i yopiq.
    expect(shop.call('reportSummary', ['2026-01-01', '2026-12-31'], { ...CASHIER, role: 'owner' })).toMatchObject({ ok: false, error: { status: 403 } })
  })

  it('blocks writes when the subscription expired, but keeps reads and closeShift', () => {
    const shop = freshShop()
    const sh = shop.ok('openShift', [0])
    expect(shop.call('saveCategory', ['Ichimlik'], OWNER, { active: false })).toMatchObject({ ok: false, error: { code: 'cloud.errors.subscriptionExpired', status: 402 } })
    expect(shop.call('listProducts', [], OWNER, { active: false }).ok).toBe(true)
    expect(shop.call('closeShift', [sh.id, 0], OWNER, { active: false }).ok).toBe(true)
  })

  it('validates input types', () => {
    const shop = freshShop()
    expect(shop.call('saveProduct', [{ name: 'X', price: 'abc' }])).toMatchObject({ ok: false, error: { code: 'cloud.errors.invalidInput', params: { field: 'price' } } })
    expect(shop.call('saveProduct', [{ name: '', price: 1 }])).toMatchObject({ ok: false, error: { params: { field: 'name' } } })
    expect(shop.call('listSales', [{ dateFrom: '2026-13-99x' }])).toMatchObject({ ok: false, error: { params: { field: 'dateFrom' } } })
  })
})

describe('createSale', () => {
  function setup() {
    const shop = freshShop({ withCashier: true })
    const cola = seedProduct(shop, { name: 'Cola', price: 10000, cost: 7000, stock: 10 })
    const suv = seedProduct(shop, { name: 'Suv', price: 3000, cost: 2000, stock: 5 })
    const shift = shop.ok('openShift', [0])
    const ali = shop.ok<number>('saveCustomer', ['Ali do\'kon', '+998901112233'])
    return { shop, cola, suv, shift, ali }
  }

  it('writes sale, items, stock and debt in one go (prices from DB)', () => {
    const { shop, cola, suv, shift, ali } = setup()
    const sale = shop.ok('createSale', [{ shiftId: shift.id, customerId: ali, items: [line(cola, 2, 10000), line(suv, 1, 3000)], paidCash: 5000, paidCard: 0, discount: 1000 }])
    expect(sale).toMatchObject({ receipt_number: `${shift.id}-00001`, total: 22000, discount: 1000, paid_cash: 5000, debt_amount: 17000, payment_status: 'partial', user_id: OWNER.uid })
    const items = shop.sql.all<any>('SELECT product_name, price, cost_price, qty, subtotal FROM sale_items WHERE sale_id = ? ORDER BY id', sale.id)
    // Nom va tannarx bazadan (klient "x" va 0 yuborgan).
    expect(items).toEqual([
      { product_name: 'Cola', price: 10000, cost_price: 7000, qty: 2, subtotal: 20000 },
      { product_name: 'Suv', price: 3000, cost_price: 2000, qty: 1, subtotal: 3000 },
    ])
    expect(shop.sql.get<any>('SELECT stock FROM products WHERE id = ?', cola).stock).toBe(8)
    expect(shop.sql.get<any>('SELECT balance FROM customers WHERE id = ?', ali).balance).toBe(-17000)
    const second = shop.ok('createSale', [{ shiftId: shift.id, customerId: walkInId(shop), items: [line(suv, 1, 3000)], paidCash: 3000, paidCard: 0, discount: 0 }])
    expect(second.receipt_number).toBe(`${shift.id}-00002`)
  })

  it('rolls back everything when a later line fails (no half-written receipt)', () => {
    const { shop, cola, suv, shift } = setup()
    const r = shop.call('createSale', [{ shiftId: shift.id, customerId: walkInId(shop), items: [line(cola, 1, 10000), line(suv, 99, 3000)], paidCash: 307000, paidCard: 0, discount: 0 }])
    expect(r).toMatchObject({ ok: false, error: { code: 'cloud.errors.insufficientStock', params: { name: 'Suv' } } })
    expect(shop.sql.get<any>('SELECT COUNT(*) c FROM sales').c).toBe(0)
    expect(shop.sql.get<any>('SELECT stock FROM products WHERE id = ?', cola).stock).toBe(10)
  })

  it('counts the same product on several lines against stock', () => {
    const { shop, suv, shift } = setup()
    const r = shop.call('createSale', [{ shiftId: shift.id, customerId: walkInId(shop), items: [line(suv, 3, 3000), line(suv, 3, 3000)], paidCash: 18000, paidCard: 0, discount: 0 }])
    expect(r).toMatchObject({ ok: false, error: { code: 'cloud.errors.insufficientStock' } })
  })

  it('allows negative stock when the owner enabled it', () => {
    const { shop, suv, shift } = setup()
    shop.ok('setSetting', ['allow_negative_stock', '1'])
    const sale = shop.ok('createSale', [{ shiftId: shift.id, customerId: walkInId(shop), items: [line(suv, 7, 3000)], paidCash: 21000, paidCard: 0, discount: 0 }])
    expect(sale.total).toBe(21000)
    expect(shop.sql.get<any>('SELECT stock FROM products WHERE id = ?', suv).stock).toBe(-2)
  })

  it('refuses debt for the walk-in customer', () => {
    const { shop, cola, shift } = setup()
    const r = shop.call('createSale', [{ shiftId: shift.id, customerId: walkInId(shop), items: [line(cola, 1, 10000)], paidCash: 0, paidCard: 0, discount: 0 }])
    expect(r).toMatchObject({ ok: false, error: { code: 'sales.noDebtForWalkIn' } })
  })

  it('requires the caller\'s own open shift', () => {
    const { shop, cola, shift } = setup()
    // Kassir egasining smenasiga yoza olmaydi.
    const r = shop.call('createSale', [{ shiftId: shift.id, customerId: walkInId(shop), items: [line(cola, 1, 10000)], paidCash: 10000, paidCard: 0, discount: 0 }], CASHIER)
    expect(r).toMatchObject({ ok: false, error: { code: 'cloud.errors.shiftNotOpen' } })
    shop.ok('closeShift', [shift.id, 0])
    expect(shop.call('createSale', [{ shiftId: shift.id, customerId: walkInId(shop), items: [line(cola, 1, 10000)], paidCash: 10000, paidCard: 0, discount: 0 }]).ok).toBe(false)
  })

  it('cashier cannot change price; discount only when allowed', () => {
    const { shop, cola } = setup()
    const csh = shop.ok('openShift', [0], CASHIER)
    const base = { shiftId: csh.id, customerId: walkInId(shop), paidCash: 10000, paidCard: 0 }
    expect(shop.call('createSale', [{ ...base, items: [line(cola, 1, 5000)], discount: 0 }], CASHIER)).toMatchObject({ ok: false, error: { code: 'cloud.errors.priceChanged' } })
    expect(shop.call('createSale', [{ ...base, items: [line(cola, 1, 10000)], discount: 500 }], CASHIER)).toMatchObject({ ok: false, error: { code: 'cloud.errors.discountNotAllowed' } })
    shop.ok('setSetting', ['cashier_discount', '1'])
    const sale = shop.ok('createSale', [{ ...base, items: [line(cola, 1, 10000)], discount: 500 }], CASHIER)
    expect(sale).toMatchObject({ total: 9500, user_id: CASHIER.uid })
  })

  it('replays the stored response for a repeated idempotency key (no second receipt)', () => {
    const { shop, cola, shift } = setup()
    const args = [{ shiftId: shift.id, customerId: walkInId(shop), items: [line(cola, 1, 10000)], paidCash: 10000, paidCard: 0, discount: 0 }]
    const a = shop.call('createSale', args, OWNER, { key: 'sale-key-0001' })
    const b = shop.call('createSale', args, OWNER, { key: 'sale-key-0001' })
    expect(a.ok && b.ok).toBe(true)
    expect(b).toMatchObject({ replayed: true })
    expect((b as any).data).toEqual((a as any).data)
    expect(shop.sql.get<any>('SELECT COUNT(*) c FROM sales').c).toBe(1)
    expect(shop.sql.get<any>('SELECT stock FROM products WHERE id = ?', cola).stock).toBe(9)
    // Shu kalit bilan BOSHQA tana — rad.
    const c = shop.call('createSale', [{ ...args[0], paidCash: 20000 }], OWNER, { key: 'sale-key-0001' })
    expect(c).toMatchObject({ ok: false, error: { code: 'cloud.errors.idempotencyMismatch', status: 409 } })
  })

  it('does not store a key for a failed attempt (retry after fixing works)', () => {
    const { shop, suv, shift } = setup()
    const bad = [{ shiftId: shift.id, customerId: walkInId(shop), items: [line(suv, 50, 3000)], paidCash: 150000, paidCard: 0, discount: 0 }]
    expect(shop.call('createSale', bad, OWNER, { key: 'retry-key-0001' }).ok).toBe(false)
    expect(shop.sql.get<any>('SELECT COUNT(*) c FROM idempotency').c).toBe(0)
  })
})

describe('shifts per user', () => {
  it('each member has their own shift; owner sees all, cashier only own', () => {
    const shop = freshShop({ withCashier: true })
    const own = shop.ok('openShift', [100])
    const again = shop.ok('openShift', [999])
    expect(again.id).toBe(own.id) // ikki marta bosish — bitta smena
    const csh = shop.ok('openShift', [50], CASHIER)
    expect(csh.id).not.toBe(own.id)
    expect(shop.ok('activeShift', [], CASHIER).id).toBe(csh.id)
    expect(shop.call('shiftStats', [own.id], CASHIER)).toMatchObject({ ok: false, error: { status: 403 } })
    expect(shop.call('closeShift', [own.id, 0], CASHIER)).toMatchObject({ ok: false, error: { status: 403 } })
    expect(shop.ok('shiftStats', [csh.id]).expected_cash).toBe(50)
    const list = shop.ok<any[]>('listShifts')
    expect(list.map((s) => s.user_name).sort()).toEqual(['Ega', 'Kassir'])
    expect(shop.call('listShifts', [], CASHIER).ok).toBe(false)
  })

  it('cashier sees only own sales in history', () => {
    const shop = freshShop({ withCashier: true })
    const p = seedProduct(shop, { name: 'Non', price: 4000, stock: 100 })
    const os = shop.ok('openShift', [0])
    const cs = shop.ok('openShift', [0], CASHIER)
    shop.ok('createSale', [{ shiftId: os.id, customerId: walkInId(shop), items: [line(p, 1, 4000)], paidCash: 4000, paidCard: 0, discount: 0 }])
    shop.ok('createSale', [{ shiftId: cs.id, customerId: walkInId(shop), items: [line(p, 2, 4000)], paidCash: 8000, paidCard: 0, discount: 0 }], CASHIER)
    expect(shop.ok<any[]>('listSales', [{}]).length).toBe(2)
    const mine = shop.ok<any[]>('listSales', [{}], CASHIER)
    expect(mine.length).toBe(1)
    expect(mine[0].items).toHaveLength(1)
    expect(mine[0].items[0]).toMatchObject({ qty: 2, returned_qty: 0 })
  })
})

describe('customers and debt', () => {
  it('payment raises balance; setCustomerBalance keeps the movement invariant', () => {
    const shop = freshShop()
    const p = seedProduct(shop, { name: 'Suv 19L', price: 15000, stock: 100 })
    const sh = shop.ok('openShift', [0])
    const c = shop.ok<number>('saveCustomer', ['Bahrom', null])
    shop.ok('createSale', [{ shiftId: sh.id, customerId: c, items: [line(p, 4, 15000)], paidCash: 0, paidCard: 0, discount: 0 }])
    shop.ok('recordCustomerPayment', [c, 20000, 'cash'])
    expect(shop.ok('getCustomer', [c]).balance).toBe(-40000)
    expect(shop.ok('customerMovements', [c])).toBe(-40000)
    shop.ok('setCustomerBalance', [c, -100000])
    const after = shop.ok('getCustomer', [c])
    expect(after).toMatchObject({ balance: -100000, opening_balance: -60000 })
    expect(after.opening_balance + shop.ok('customerMovements', [c])).toBe(after.balance)
    expect(shop.call('deleteCustomer', [c])).toMatchObject({ ok: false, error: { code: 'customers.hasSales' } })
    expect(shop.call('deleteCustomer', [walkInId(shop)])).toMatchObject({ ok: false, error: { code: 'customers.cannotDeleteWalkIn' } })
  })
})

describe('catalog', () => {
  it('barcode is unique; cashier does not see cost price', () => {
    const shop = freshShop({ withCashier: true })
    seedProduct(shop, { name: 'Chips', price: 5000, cost: 3500, barcode: '4780000000017' })
    expect(shop.call('saveProduct', [{ name: 'Boshqa', price: 1, barcode: '4780000000017' }])).toMatchObject({ ok: false, error: { code: 'products.barcodeInUse', params: { name: 'Chips' } } })
    expect(shop.ok('findProductByBarcode', [' 4780000000017 '], CASHIER)).toMatchObject({ name: 'Chips', cost_price: 0 })
    expect(shop.ok('findProductByBarcode', ['4780000000017'])).toMatchObject({ cost_price: 3500 })
    expect(shop.call('saveProduct', [{ name: 'X', price: 1 }], CASHIER)).toMatchObject({ ok: false, error: { status: 403 } })
  })

  it('stores images as BLOBs and returns a URL; rejects fake or huge images', () => {
    const shop = freshShop()
    // 1x1 webp
    const webp = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'
    const id = shop.ok<number>('saveProduct', [{ name: 'Rasmli', price: 1000, image: webp }])
    const p = shop.ok<any[]>('listProducts', [])[0]
    expect(p.image).toMatch(new RegExp(`^/img/t_test/${id}/v[0-9a-f]{12}$`))
    expect(shop.sql.get<any>('SELECT mime, length(data) n FROM product_images WHERE product_id = ?', id)).toMatchObject({ mime: 'image/webp' })
    // Tahrirda o'sha manzil qaytsa — rasm o'zgarmaydi.
    shop.ok('saveProduct', [{ ...p, name: 'Rasmli 2' }])
    expect(shop.ok<any[]>('listProducts', [])[0].image).toBe(p.image)
    // null — o'chiriladi.
    shop.ok('saveProduct', [{ ...p, image: null }])
    expect(shop.sql.get<any>('SELECT COUNT(*) c FROM product_images').c).toBe(0)
    // PNG deb e'lon qilingan matn.
    expect(shop.call('saveProduct', [{ name: 'Soxta', price: 1, image: 'data:image/png;base64,' + btoa('hello world!') }])).toMatchObject({ ok: false, error: { code: 'cloud.errors.imageInvalid' } })
    const big = 'data:image/jpeg;base64,' + btoa('\xff\xd8\xff' + 'a'.repeat(310 * 1024))
    expect(shop.call('saveProduct', [{ name: 'Katta', price: 1, image: big }])).toMatchObject({ ok: false, error: { code: 'cloud.errors.imageTooLarge' } })
    // Begona manzil — rad.
    expect(shop.call('saveProduct', [{ name: 'Y', price: 1, image: 'https://evil.example/x.png' }])).toMatchObject({ ok: false, error: { code: 'cloud.errors.invalidInput' } })
  })

  it('bulk price change uses bound parameters and floors at zero', () => {
    const shop = freshShop()
    seedProduct(shop, { name: 'A', price: 1000 })
    seedProduct(shop, { name: 'B', price: 300 })
    expect(shop.ok('bulkPricePreview', [{ scope: 'all', mode: 'amount', direction: 'down', value: 500 }])).toEqual({
      count: 2, preview: [{ id: 1, name: 'A', old_price: 1000, new_price: 500 }, { id: 2, name: 'B', old_price: 300, new_price: 0 }],
    })
    expect(shop.ok('bulkAdjustPrices', [{ scope: 'all', mode: 'percent', direction: 'up', value: 10 }])).toBe(2)
    expect(shop.sql.all<any>('SELECT price FROM products ORDER BY id').map((r) => r.price)).toEqual([1100, 330])
  })
})

describe('settings', () => {
  it('only allowlisted keys are readable/writable', () => {
    const shop = freshShop({ withCashier: true })
    expect(shop.ok('getSetting', ['currency_symbol', ''], CASHIER)).toBe("so'm")
    shop.sql.run("INSERT INTO settings(key, value) VALUES('auth_pin', '9999')")
    expect(shop.ok('getSetting', ['auth_pin', 'none'])).toBe('none')
    expect(shop.call('setSetting', ['auth_pin', '0000'])).toMatchObject({ ok: false, error: { status: 403 } })
    expect(shop.call('setSetting', ['shop_name', 'Yangi'], CASHIER)).toMatchObject({ ok: false, error: { status: 403 } })
  })
})
