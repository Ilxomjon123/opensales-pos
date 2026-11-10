import { DatabaseSync } from 'node:sqlite'
import { nodeSql, type Sql } from '../../src/shop/sql'
import { migrate } from '../../src/shop/schema'
import { initShop, syncMember } from '../../src/shop/init'
import { dispatch, type RpcResult, type Role } from '../../src/shop/rpc'
import { OPS } from '../../src/shop/ops'

export const OWNER = { uid: 1001, name: 'Ega', role: 'owner' as Role }
export const CASHIER = { uid: 2002, name: 'Kassir', role: 'cashier' as Role }

export type Shop = {
  db: DatabaseSync
  sql: Sql
  /** Op chaqiradi; xato bo'lsa javobni qaytaradi (tashlamaydi). */
  call(op: string, args?: unknown, as?: { uid: number; name: string; role: Role }, opts?: { key?: string; active?: boolean }): RpcResult
  /** Muvaffaqiyatli javob ma'lumoti; xato bo'lsa tashlaydi. */
  ok<T = any>(op: string, args?: unknown, as?: { uid: number; name: string; role: Role }, opts?: { key?: string }): T
}

export function freshShop(opts: { withCashier?: boolean } = {}): Shop {
  const db = new DatabaseSync(':memory:')
  const sql = nodeSql(db)
  migrate(sql)
  initShop(sql, {
    tenantId: 't_test',
    shopName: 'Test do\'kon',
    owner: { uid: OWNER.uid, name: OWNER.name },
    subscription: { trialUntil: '2999-01-01T00:00:00.000Z', paidUntil: null, status: 'active' },
  }, new Date().toISOString())
  if (opts.withCashier) syncMember(sql, { uid: CASHIER.uid, name: CASHIER.name, role: 'cashier', active: true }, new Date().toISOString())
  const call: Shop['call'] = (op, args = [], as = OWNER, o = {}) =>
    dispatch(sql, OPS, op, args, as, { idempotencyKey: o.key ?? null, subscriptionActive: o.active ?? true, imageUrl: (pid, ver) => `/img/t_test/${pid}/${ver}` })
  const ok: Shop['ok'] = (op, args, as, o) => {
    const r = call(op, args, as, o)
    if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`)
    return r.data as any
  }
  return { db, sql, call, ok }
}

/** Mahsulot yaratib, qoldiqni to'g'ridan-to'g'ri qo'yadi (jurnal testlari alohida). */
export function seedProduct(shop: Shop, p: { name: string; price: number; cost?: number; stock?: number; barcode?: string; unit?: string }): number {
  const id = shop.ok<number>('saveProduct', [{ name: p.name, price: p.price, cost_price: p.cost ?? 0, unit: p.unit ?? 'dona', barcode: p.barcode ?? null }])
  if (p.stock !== undefined) shop.sql.run('UPDATE products SET stock = ? WHERE id = ?', p.stock, id)
  return id
}

export function walkInId(shop: Shop): number {
  return shop.sql.get<{ id: number }>('SELECT id FROM customers WHERE is_walk_in = 1')!.id
}

export function line(productId: number, qty: number, price: number) {
  return { product_id: productId, name: 'x', unit: 'dona', price, cost_price: 0, qty, stock: 0 }
}

// ---- Rust testlari (src-tauri/src/returns.rs tests) bilan bir xil yordamchilar ----

export function openShiftSql(shop: Shop, uid = OWNER.uid): number {
  return shop.sql.get<{ id: number }>("INSERT INTO shifts(opened_at, opening_cash, status, user_id) VALUES('2026-01-01T08:00:00Z', 0, 'open', ?) RETURNING id", uid)!.id
}

export function customerSql(shop: Shop, name = 'Ali'): number {
  return shop.sql.get<{ id: number }>('INSERT INTO customers(name, is_walk_in) VALUES(?, 0) RETURNING id', name)!.id
}

/** Rust product(): tannarx = narx / 2 (butun bo'lish). */
export function productSql(shop: Shop, name: string, price: number, stock: number): number {
  return shop.sql.get<{ id: number }>('INSERT INTO products(name, price, cost_price, stock) VALUES(?,?,?,?) RETURNING id', name, price, Math.trunc(price / 2), stock)!.id
}

/** Rust sale(): db.ts createSale bilan bir xil yozuv (to'g'ridan-to'g'ri SQL). */
export function saleSql(shop: Shop, shift: number, cust: number, lines: [number, number, number][], discount: number, paid: number): [number, number[]] {
  const subtotal = lines.reduce((s, [, p, q]) => s + Math.round(p * q), 0)
  const total = Math.max(0, subtotal - discount)
  const debt = Math.max(0, total - paid)
  const status = debt === 0 ? 'paid' : paid === 0 ? 'debt' : 'partial'
  const n = shop.sql.get<{ n: number }>('SELECT COUNT(*) + 1 n FROM sales')!.n
  const saleId = shop.sql.get<{ id: number }>(
    `INSERT INTO sales(receipt_number, shift_id, customer_id, total, discount, paid_cash, paid_card, paid_amount, debt_amount, payment_status, created_at)
     VALUES(?,?,?,?,?,?,0,?,?,?, '2026-01-01T09:00:00Z') RETURNING id`,
    `${shift}-${String(n).padStart(5, '0')}`, shift, cust, total, discount, paid, paid, debt, status,
  )!.id
  const itemIds: number[] = []
  for (const [pid, price, qty] of lines) {
    const name = shop.sql.get<{ name: string }>('SELECT name FROM products WHERE id = ?', pid)!.name
    itemIds.push(shop.sql.get<{ id: number }>(
      "INSERT INTO sale_items(sale_id, product_id, product_name, price, cost_price, qty, unit, subtotal) VALUES(?,?,?,?,?,?, 'dona', ?) RETURNING id",
      saleId, pid, name, price, Math.trunc(price / 2), qty, Math.round(price * qty),
    )!.id)
    shop.sql.run('UPDATE products SET stock = stock - ? WHERE id = ?', qty, pid)
  }
  shop.sql.run('UPDATE customers SET balance = balance - ? WHERE id = ? AND is_walk_in = 0', debt, cust)
  return [saleId, itemIds]
}

export const stockOf = (shop: Shop, pid: number) => shop.sql.get<{ s: number }>('SELECT stock s FROM products WHERE id = ?', pid)!.s
export const balanceOf = (shop: Shop, cid: number) => shop.sql.get<{ b: number }>('SELECT balance b FROM customers WHERE id = ?', cid)!.b
export const countOf = (shop: Shop, table: string) => shop.sql.get<{ c: number }>(`SELECT COUNT(*) c FROM ${table}`)!.c

/** Xato kodi (muvaffaqiyat bo'lsa test yiqiladi). */
export function errCode(r: { ok: boolean; error?: { code: string } } | any): string {
  if (r.ok) throw new Error('xato kutilgan edi: ' + JSON.stringify(r.data))
  return r.error.code
}
