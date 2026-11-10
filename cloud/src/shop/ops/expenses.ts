import { DomainError } from '../errors'
import type { OpTable } from '../rpc'
import * as v from '../v'
import { ownOpenShift } from './shifts'

// Xarajatlar — src/lib/db.ts porti.

// Desktop dayIso: bugun → joriy vaqt, aks holda o'sha kun peshini UTC.
export function dayIso(now: string, date?: string): string {
  if (!date) return now
  if (date === now.slice(0, 10)) return now
  return `${date}T12:00:00.000Z`
}

export const expenseOps: OpTable = {
  listExpenses: {
    access: 'owner',
    write: false,
    run(ctx, raw) {
      const f = v.optObj(v.args(raw)[0], 'filter')
      const where: string[] = []
      const args: string[] = []
      const from = v.optDay(f.dateFrom, 'dateFrom')
      if (from) { where.push('date(created_at) >= date(?)'); args.push(from) }
      const to = v.optDay(f.dateTo, 'dateTo')
      if (to) { where.push('date(created_at) <= date(?)'); args.push(to) }
      const category = v.optStr(f.category, 'category', 100)
      if (category) { where.push('category = ?'); args.push(category) }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
      return ctx.sql.all(`SELECT * FROM expenses ${w} ORDER BY id DESC`, ...args)
    },
  },
  saveExpense: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const e = v.obj(v.args(raw)[0], 'expense')
      const amount = Math.max(0, v.money(e.amount ?? 0, 'amount'))
      if (amount === 0) throw new DomainError('expenses.amountMustBePositive')
      const category = (v.optStr(e.category, 'category', 100) ?? '').trim() || 'Boshqa'
      const note = (v.optStr(e.note, 'note', 500) ?? '').trim() || null
      const createdAt = dayIso(ctx.now(), v.optDay(e.date, 'date'))
      const id = v.optId(e.id)
      if (id) {
        ctx.sql.run('UPDATE expenses SET amount=?, category=?, note=?, created_at=? WHERE id=?', amount, category, note, createdAt, id)
      } else {
        const sh = ownOpenShift(ctx)
        ctx.sql.run('INSERT INTO expenses(amount, category, note, shift_id, created_at, user_id) VALUES(?,?,?,?,?,?)',
          amount, category, note, sh?.id ?? null, createdAt, ctx.actor.uid)
      }
      return null
    },
  },
  deleteExpense: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      ctx.sql.run('DELETE FROM expenses WHERE id = ?', v.id(v.args(raw)[0]))
      return null
    },
  },
  expensesTotal: {
    access: 'owner',
    write: false,
    run(ctx, raw) {
      const [from, to] = v.args(raw)
      const r = ctx.sql.get<{ t: number }>(
        'SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE date(created_at) BETWEEN ? AND ?',
        v.day(from, 'dateFrom'), v.day(to, 'dateTo'),
      )
      return r?.t ?? 0
    },
  },
}
