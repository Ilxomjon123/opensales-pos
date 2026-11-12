import { DomainError, invalid } from '../errors'
import type { Ctx, OpTable } from '../rpc'
import * as v from '../v'

// Mijozlar va qarz — src/lib/db.ts porti.

type Customer = { id: number; name: string; phone: string | null; balance: number; opening_balance: number; is_walk_in: number; is_active: number }

function movements(ctx: Ctx, customerId: number): number {
  const r = ctx.sql.get<{ pays: number; debts: number; returns: number }>(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = ?), 0) pays,
       COALESCE((SELECT SUM(debt_amount) FROM sales WHERE customer_id = ?), 0) debts,
       COALESCE((SELECT SUM(refund_balance) FROM sale_returns WHERE customer_id = ?), 0) returns`,
    customerId, customerId, customerId,
  )
  return (r?.pays ?? 0) + (r?.returns ?? 0) - (r?.debts ?? 0)
}

function requireCustomer(ctx: Ctx, id: number): Customer {
  const c = ctx.sql.get<Customer>('SELECT * FROM customers WHERE id = ?', id)
  if (!c) throw new DomainError('sales.customerNotFound', {}, 404)
  return c
}

const PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const

export const customerOps: OpTable = {
  listCustomers: {
    access: 'cashier',
    write: false,
    run(ctx, raw) {
      const where = v.optBool(v.args(raw)[0], 'activeOnly', false) ? 'WHERE is_active = 1' : ''
      return ctx.sql.all(`SELECT * FROM customers ${where} ORDER BY is_walk_in DESC, name`)
    },
  },
  setCustomerActive: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const [id, active] = v.args(raw)
      ctx.sql.run('UPDATE customers SET is_active = ? WHERE id = ?', v.bool(active, 'active') ? 1 : 0, v.id(id))
      return null
    },
  },
  deleteCustomer: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const id = v.id(v.args(raw)[0])
      const c = ctx.sql.get<Customer>('SELECT * FROM customers WHERE id = ?', id)
      if (!c) return null
      if (c.is_walk_in) throw new DomainError('customers.cannotDeleteWalkIn')
      const sales = ctx.sql.get<{ c: number }>('SELECT COUNT(*) c FROM sales WHERE customer_id = ?', id)
      if ((sales?.c ?? 0) > 0) throw new DomainError('customers.hasSales')
      ctx.sql.run('DELETE FROM customers WHERE id = ?', id)
      return null
    },
  },
  getCustomer: {
    access: 'owner',
    write: false,
    run: (ctx, raw) => ctx.sql.get('SELECT * FROM customers WHERE id = ?', v.id(v.args(raw)[0])) ?? null,
  },
  customerSales: {
    access: 'owner',
    write: false,
    run: (ctx, raw) => ctx.sql.all('SELECT * FROM sales WHERE customer_id = ? ORDER BY id DESC', v.id(v.args(raw)[0])),
  },
  customerPayments: {
    access: 'owner',
    write: false,
    run: (ctx, raw) => ctx.sql.all('SELECT * FROM customer_payments WHERE customer_id = ? ORDER BY id DESC', v.id(v.args(raw)[0])),
  },
  // Mijozdan to'lov qabul qilish — balans oshadi (qarz kamayadi).
  recordCustomerPayment: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const [cid, amountRaw, methodRaw, noteRaw] = v.args(raw)
      const customerId = v.id(cid, 'customerId')
      const a = Math.max(0, v.money(amountRaw, 'amount'))
      const method = v.oneOf(methodRaw, 'method', PAYMENT_METHODS)
      const note = v.optStr(noteRaw, 'note', 500)
      if (a === 0) return null
      requireCustomer(ctx, customerId)
      ctx.sql.run(
        'INSERT INTO customer_payments(customer_id, amount, method, note, created_at, user_id) VALUES(?,?,?,?,?,?)',
        customerId, a, method, note ?? null, ctx.now(), ctx.actor.uid,
      )
      ctx.sql.run('UPDATE customers SET balance = balance + ? WHERE id = ?', a, customerId)
      return null
    },
  },
  // Mijozga qarz berish (pul do'kondan chiqdi) — `customer_payments` da MANFIY summa: balans kamayadi (qarz oshadi),
  // mijoz harakatlari (movements) va saldo invarianti o'zgarmaydi. Hozircha faqat AI yordamchisi orqali (2026-11-12).
  recordCustomerPayout: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const [cid, amountRaw, methodRaw, noteRaw] = v.args(raw)
      const customerId = v.id(cid, 'customerId')
      const a = Math.max(0, v.money(amountRaw, 'amount'))
      const method = v.oneOf(methodRaw, 'method', PAYMENT_METHODS)
      const note = v.optStr(noteRaw, 'note', 500)
      if (a === 0) return null
      // Yo'l-yo'lakay xaridor — umumiy hisob, unga qarz yozilmaydi (sotuvdagi kabi).
      if (requireCustomer(ctx, customerId).is_walk_in) throw new DomainError('sales.noDebtForWalkIn')
      ctx.sql.run(
        'INSERT INTO customer_payments(customer_id, amount, method, note, created_at, user_id) VALUES(?,?,?,?,?,?)',
        customerId, -a, method, note ?? null, ctx.now(), ctx.actor.uid,
      )
      ctx.sql.run('UPDATE customers SET balance = balance - ? WHERE id = ?', a, customerId)
      return null
    },
  },
  saveCustomer: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const [nameRaw, phoneRaw, idRaw] = v.args(raw)
      const name = v.str(nameRaw, 'name', 200).trim()
      if (!name) throw invalid('name')
      const phone = v.optStr(phoneRaw, 'phone', 40)
      const id = v.optId(idRaw)
      if (id) {
        ctx.sql.run('UPDATE customers SET name=?, phone=? WHERE id=?', name, phone, id)
        return id
      }
      return ctx.sql.get<{ id: number }>('INSERT INTO customers(name, phone) VALUES(?, ?) RETURNING id', name, phone)!.id
    },
  },
  // Tizim ichidagi sof harakat: to'lovlar + vozvratdan balansga yozilgan − berilgan qarzlar.
  customerMovements: {
    access: 'owner',
    write: false,
    run: (ctx, raw) => movements(ctx, v.id(v.args(raw)[0])),
  },
  // Joriy saldoni belgilash: farq dastlabki saldo sifatida saqlanadi. Manfiy = qarzdor.
  setCustomerBalance: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const [cid, targetRaw] = v.args(raw)
      const customerId = v.id(cid, 'customerId')
      const target = v.money(targetRaw, 'targetBalance')
      requireCustomer(ctx, customerId)
      const opening = target - movements(ctx, customerId)
      ctx.sql.run('UPDATE customers SET opening_balance = ?, balance = ? WHERE id = ?', opening, target, customerId)
      return null
    },
  },
}
