import type { Sql } from './sql'
import type { Actor, Ctx } from './rpc'
import { DomainError } from './errors'
import { catalogSource } from './catalogSync'
import { normalizeQty, QTY_EPS } from './money'
import { createReceipt } from './ops/stock'

// Do'konlararo ko'chirish (2026-11-09). Ikki bosqich, bitta `id` bilan (ikkala do'konda bir xil):
//   1) manba: `transferOut` — qoldiq tekshiruvi va kamaytirish (stock_adjustments, izohda qabul do'koni),
//      `transfers` qatori `pending` — hammasi BITTA tranzaksiyada;
//   2) qabul: `transferIn` — kirim (stock_receipts.transfer_id, tannarx = manbaniki → o'rtacha tannarx to'g'ri);
//      o'sha id bilan takror chaqirilsa yangi narsa yozilmaydi;
//   3) manba: `transferDone`. 2-bosqich uzilsa manba alarm'i qayta yuboradi.
// Tovar moslash 1-bosqichdan OLDIN (`planTransferIn`) — qabul tomonda moslab bo'lmaydigan satr bilan
// manbadagi qoldiq hech qachon kamaymaydi.

export const MAX_TRANSFER_LINES = 200
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/

export type TransferLine = {
  productId: number; name: string; unit: string; qty: number; cost: number; price: number; barcode: string | null
  /** Qabul do'konidagi tovar; null — qabul do'konida yangi tovar yaratiladi. */
  targetProductId: number | null
}
export type TransferRow = {
  id: string; direction: 'out' | 'in'; peer_tenant: string; peer_name: string; status: 'pending' | 'done'
  items: TransferLine[]; total_cost: number; note: string | null; user_id: number | null; user_name: string | null
  receipt_id: number | null; created_at: string; done_at: string | null
}
export type TransferInput = { productId: number; qty: number }
/** DO metodlari javobi (DomainError — xato obyekti sifatida, RPC orqali). */
export type Guarded<T> = { ok: true; data: T } | { ok: false; error: { code: string; params: Record<string, unknown>; status: number } }
export type PlanLine = { name: string; unit: string; barcode: string | null; productId: number }

const err = (code: string, params: Record<string, unknown> = {}, status = 422) => new DomainError(`cloud.transfers.errors.${code}`, params, status)

export function validTransferId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function rowOf(r: Record<string, unknown>): TransferRow {
  return { ...(r as unknown as TransferRow), items: JSON.parse(String(r.items)) }
}

export function getTransfer(sql: Sql, id: string): TransferRow | null {
  const r = sql.get<Record<string, unknown>>('SELECT * FROM transfers WHERE id = ?', id)
  return r ? rowOf(r) : null
}

export function listTransfers(sql: Sql, limit = 200): TransferRow[] {
  return sql.all<Record<string, unknown>>('SELECT * FROM transfers ORDER BY created_at DESC, id LIMIT ?', limit).map(rowOf)
}

export function pendingOut(sql: Sql): TransferRow[] {
  return sql.all<Record<string, unknown>>("SELECT * FROM transfers WHERE status = 'pending' AND direction = 'out' ORDER BY created_at LIMIT 20").map(rowOf)
}

/**
 * Qabul do'koni: manba satrlarini o'z tovarlariga moslaydi. Umumiy katalog (asosiy↔filial) — bir xil id;
 * aks holda shtrix-kod, keyin aniq nom + birlik. Topilmasa — alohida do'konda yangi tovar (null),
 * filialda esa (katalog asosiy do'konniki) — xato.
 */
export function planTransferIn(sql: Sql, lines: PlanLine[], sharedCatalog: boolean): { targetProductId: number | null }[] {
  const branch = !!catalogSource(sql)
  return lines.map((l) => {
    if (sharedCatalog) {
      const p = sql.get<{ id: number }>('SELECT id FROM products WHERE id = ?', l.productId)
      if (p) return { targetProductId: p.id }
    }
    if (l.barcode) {
      const p = sql.get<{ id: number }>('SELECT id FROM products WHERE barcode = ? LIMIT 1', l.barcode)
      if (p) return { targetProductId: p.id }
    }
    const p = sql.get<{ id: number }>('SELECT id FROM products WHERE lower(trim(name)) = lower(trim(?)) AND unit = ? ORDER BY is_active DESC, id LIMIT 1', l.name, l.unit)
    if (p) return { targetProductId: p.id }
    if (branch) throw err('notInCatalog', { name: l.name }, 409)
    return { targetProductId: null }
  })
}

/** Manba: satrlarni tekshirib (planlashdan oldin) qabul uchun ma'lumot. */
export function describeLines(sql: Sql, input: TransferInput[]): PlanLine[] {
  if (!Array.isArray(input) || input.length === 0) throw err('noLines')
  if (input.length > MAX_TRANSFER_LINES) throw err('tooManyLines', { max: MAX_TRANSFER_LINES })
  const seen = new Set<number>()
  return input.map((l) => {
    const p = sql.get<{ id: number; name: string; unit: string; barcode: string | null }>('SELECT id, name, unit, barcode FROM products WHERE id = ?', l.productId)
    if (!p) throw err('productNotFound', { productId: l.productId }, 404)
    if (seen.has(p.id)) throw err('duplicateLine', { name: p.name })
    seen.add(p.id)
    return { productId: p.id, name: p.name, unit: p.unit, barcode: p.barcode }
  })
}

export function transferOut(sql: Sql, p: { id: string; actor: Actor; peer: string; peerName: string; input: TransferInput[]; targets: { targetProductId: number | null }[]; note: string | null; now: string; allowNegative: boolean }): TransferRow {
  return sql.tx(() => {
    const existing = getTransfer(sql, p.id)
    if (existing) return existing
    const lines: TransferLine[] = []
    for (const [i, l] of p.input.entries()) {
      const prod = sql.get<{ id: number; name: string; unit: string; stock: number; cost: number; price: number; barcode: string | null }>(
        'SELECT id, name, unit, CAST(stock AS REAL) stock, cost_price cost, price, barcode FROM products WHERE id = ?', l.productId,
      )
      if (!prod) throw err('productNotFound', { productId: l.productId }, 404)
      const q = Number(l.qty)
      if (!Number.isFinite(q) || q <= 0 || q > 1e9) throw err('invalidQty', { name: prod.name })
      const qty = normalizeQty(q)
      if (qty <= 0) throw err('invalidQty', { name: prod.name })
      if (!p.allowNegative && prod.stock - qty < -QTY_EPS) throw err('insufficientStock', { name: prod.name, stock: prod.stock, unit: prod.unit })
      const after = normalizeQty(prod.stock - qty)
      sql.run('UPDATE products SET stock = ? WHERE id = ?', after, prod.id)
      sql.run(
        'INSERT INTO stock_adjustments(product_id, product_name, unit, qty_before, qty_after, delta, kind, note, created_at, user_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        prod.id, prod.name, prod.unit, prod.stock, after, -qty, 'transfer', `→ ${p.peerName}${p.note ? ` · ${p.note}` : ''}`, p.now, p.actor.uid,
      )
      lines.push({ productId: prod.id, name: prod.name, unit: prod.unit, qty, cost: prod.cost, price: prod.price, barcode: prod.barcode, targetProductId: p.targets[i]?.targetProductId ?? null })
    }
    const total = Math.round(lines.reduce((s, l) => s + l.qty * l.cost, 0))
    sql.run(
      `INSERT INTO transfers(id, direction, peer_tenant, peer_name, status, items, total_cost, note, user_id, user_name, created_at)
       VALUES(?, 'out', ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      p.id, p.peer, p.peerName, JSON.stringify(lines), total, p.note, p.actor.uid, p.actor.name, p.now,
    )
    return getTransfer(sql, p.id)!
  })
}

/** Qabul: kirim (idempotent). Yangi tovar kerak bo'lsa (alohida do'kon) — shu yerda yaratiladi. */
export function transferIn(ctx: Ctx, p: { id: string; peer: string; peerName: string; lines: TransferLine[]; note: string | null }): TransferRow {
  const sql = ctx.sql
  return sql.tx(() => {
    const existing = getTransfer(sql, p.id)
    if (existing) return existing
    const branch = !!catalogSource(sql)
    const resolved = p.lines.map((l) => {
      if (l.targetProductId !== null && sql.get('SELECT 1 FROM products WHERE id = ?', l.targetProductId)) return { ...l, target: l.targetProductId }
      // Rejadagi tovar yo'qolgan (yoki yangi kerak) — qayta moslaymiz.
      const [m] = planTransferIn(sql, [l], false)
      if (m.targetProductId !== null) return { ...l, target: m.targetProductId }
      if (branch) throw err('notInCatalog', { name: l.name }, 409)
      const barcode = l.barcode && !sql.get('SELECT 1 FROM products WHERE barcode = ?', l.barcode) ? l.barcode : null
      const created = sql.get<{ id: number }>(
        'INSERT INTO products(name, price, cost_price, stock, unit, barcode) VALUES(?,?,?,0,?,?) RETURNING id', l.name, l.price, l.cost, l.unit, barcode,
      )!
      return { ...l, target: created.id }
    })
    const receipt = createReceipt(ctx, {
      supplier: `↔ ${p.peerName}`.slice(0, 120),
      note: p.note,
      lines: resolved.map((l) => ({ productId: l.target, qty: l.qty, costPrice: l.cost })),
    }) as { id: number }
    sql.run('UPDATE stock_receipts SET transfer_id = ? WHERE id = ?', p.id, receipt.id)
    const items = resolved.map(({ target, ...l }) => ({ ...l, targetProductId: target }))
    const total = Math.round(items.reduce((s, l) => s + l.qty * l.cost, 0))
    sql.run(
      `INSERT INTO transfers(id, direction, peer_tenant, peer_name, status, items, total_cost, note, user_id, user_name, receipt_id, created_at, done_at)
       VALUES(?, 'in', ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id, p.peer, p.peerName, JSON.stringify(items), total, p.note, ctx.actor.uid, ctx.actor.name, receipt.id, ctx.now(), ctx.now(),
    )
    return getTransfer(sql, p.id)!
  })
}

export function transferDone(sql: Sql, id: string, now: string): void {
  sql.run("UPDATE transfers SET status = 'done', done_at = ? WHERE id = ? AND direction = 'out' AND status = 'pending'", now, id)
}

export function bumpAttempt(sql: Sql, id: string): void {
  sql.run('UPDATE transfers SET attempts = attempts + 1 WHERE id = ?', id)
}
