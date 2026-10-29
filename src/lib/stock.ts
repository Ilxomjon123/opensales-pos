import { invoke } from '@tauri-apps/api/core'
import { db } from './db'
import { t } from './i18n'

// Tovar kirimi (prixod), qoldiq tuzatish va tovar harakati hisoboti.
// Yozish Rust'da (src-tauri/src/stock.rs): bitta tranzaksiya, tekshiruvlar va tannarx o'sha
// yerda. Bu fayl — yupqa IPC qatlami + o'qish so'rovlari + xato matnlari.

export type ReceiptLineInput = { productId: number; qty: number; costPrice: number; salePrice: number | null }
export type ReceiptRequest = { supplier: string | null; note: string | null; receivedAt: string | null; lines: ReceiptLineInput[] }
export type CreatedReceipt = { id: number; receiptNumber: string; total: number; receivedAt: string; lines: number }
export type StockAdjusted = { productId: number; qtyBefore: number; qtyAfter: number; delta: number; recorded: boolean }
export type AdjustKind = 'initial' | 'manual'

type StockError = { code: string; params?: Record<string, unknown> }

function isStockError(e: unknown): e is StockError {
  return typeof e === 'object' && e !== null && typeof (e as StockError).code === 'string'
}

// Rust xato kodini foydalanuvchi tilidagi matnga aylantiradi.
export function stockErrorMessage(e: unknown): string {
  if (!isStockError(e)) return e instanceof Error ? e.message : String(e)
  const key = `stock.errors.${e.code}`
  const msg = t(key, e.params ?? {})
  return msg === key ? t('stock.errors.unknown', { code: e.code }) : msg
}

// db() — pool ro'yxatga olingani va sxema self-heal bo'lganiga kafolat (Rust shu pool'ni oladi).
export async function createStockReceipt(request: ReceiptRequest): Promise<CreatedReceipt> {
  await db()
  return invoke<CreatedReceipt>('create_stock_receipt', { request })
}

export async function voidStockReceipt(receiptId: number, reason: string | null): Promise<void> {
  await db()
  await invoke('void_stock_receipt', { receiptId, reason })
}

export async function adjustProductStock(productId: number, newStock: number, kind: AdjustKind, note: string | null = null): Promise<StockAdjusted> {
  await db()
  return invoke<StockAdjusted>('adjust_product_stock', { productId, newStock, kind, note })
}

// ---- Kirimlar ro'yxati ----
export type StockReceipt = {
  id: number
  receipt_number: string
  supplier: string | null
  note: string | null
  total: number
  received_at: string
  created_at: string
  voided_at: string | null
  void_reason: string | null
}
export type StockReceiptItem = {
  id: number
  receipt_id: number
  product_id: number | null
  product_name: string
  unit: string
  qty: number
  cost_price: number
  subtotal: number
  sale_price: number | null
}
export type StockReceiptRow = StockReceipt & { items: StockReceiptItem[] }
export type ReceiptStatus = 'active' | 'voided'
export type ReceiptsFilter = { productId?: number; dateFrom?: string; dateTo?: string; status?: ReceiptStatus }

// Holat filtri — SQL faqat shu ro'yxatdan (foydalanuvchi matni so'rovga qo'shilmaydi).
const RECEIPT_STATUS_SQL: Record<ReceiptStatus, string> = {
  active: 'r.voided_at IS NULL',
  voided: 'r.voided_at IS NOT NULL',
}

export async function listStockReceipts(f: ReceiptsFilter = {}): Promise<StockReceiptRow[]> {
  const d = await db()
  const where: string[] = []
  const args: unknown[] = []
  if (f.productId) { where.push('EXISTS (SELECT 1 FROM stock_receipt_items i WHERE i.receipt_id = r.id AND i.product_id = ?)'); args.push(f.productId) }
  if (f.dateFrom) { where.push('date(r.received_at) >= date(?)'); args.push(f.dateFrom) }
  if (f.dateTo) { where.push('date(r.received_at) <= date(?)'); args.push(f.dateTo) }
  if (f.status) where.push(RECEIPT_STATUS_SQL[f.status])
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const rows = await d.select<StockReceipt[]>(`SELECT r.* FROM stock_receipts r ${w} ORDER BY r.received_at DESC, r.id DESC LIMIT 1000`, args)
  const byReceipt = new Map<number, StockReceiptItem[]>()
  if (rows.length) {
    const ids = rows.map((r) => r.id)
    const items = await d.select<StockReceiptItem[]>(
      `SELECT id, receipt_id, product_id, product_name, unit, qty, cost_price, subtotal, sale_price
       FROM stock_receipt_items WHERE receipt_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      ids,
    )
    for (const it of items) byReceipt.set(it.receipt_id, [...(byReceipt.get(it.receipt_id) ?? []), it])
  }
  return rows.map((r) => ({ ...r, items: byReceipt.get(r.id) ?? [] }))
}

// Oldingi kirimlardagi ta'minotchilar (eng so'nggisi birinchi) — kiritishda taklif uchun.
export async function receiptSuppliers(): Promise<string[]> {
  const d = await db()
  const r = await d.select<{ supplier: string }[]>(
    'SELECT supplier FROM stock_receipts WHERE supplier IS NOT NULL GROUP BY supplier ORDER BY MAX(id) DESC LIMIT 50',
  )
  return r.map((x) => x.supplier)
}

// ---- Harakat jurnali (Davr harakati, Mahsulot harakati) ----
// Qoldiqni o'zgartiradigan to'rt jurnal (stock.rs izohi) bitta ro'yxatga yig'iladi:
// kirim (+, ta'minotchi), sotuv (−, mijoz), vozvrat (+, mijoz), tuzatish (±). Bekor
// qilingan kirim umuman yo'q (qoldig'i ham qaytarilgan). Sana — date(ISO), ya'ni UTC kuni
// (Hisobot va boshqa bo'limlar bilan bir xil).
//
// Qoldiq orqaga tiklanadi: jurnal 0 dan emas, JORIY qoldiqdan hisoblanadi — bu versiyadan
// oldingi qo'lda o'zgarishlar jurnalda yo'q, ular "boshlang'ich" ga qo'shiladi. Shuning
// uchun Davr harakati qatori va Mahsulot harakati kartochkasi bir xil qoidada: yakuniy =
// joriy qoldiq − davrdan keyingi harakatlar, boshlang'ich = yakuniy − davr ichidagilari.
const MOVES_SQL = `
  SELECT 'receipt' kind, ri.product_id pid, r.id doc_id, ri.id line_id, r.receipt_number number,
         r.received_at at, r.supplier supplier, NULL customer_id, r.note comment,
         ri.qty delta, ri.cost_price price, ri.subtotal amount
  FROM stock_receipt_items ri JOIN stock_receipts r ON r.id = ri.receipt_id WHERE r.voided_at IS NULL
  UNION ALL
  SELECT 'sale', si.product_id, s.id, si.id, s.receipt_number, s.created_at, NULL, s.customer_id, s.note,
         -si.qty, si.price, si.subtotal
  FROM sale_items si JOIN sales s ON s.id = si.sale_id
  UNION ALL
  SELECT 'return', ri.product_id, r.id, ri.id, r.return_number, r.created_at, NULL, r.customer_id, r.reason,
         ri.qty, ri.price, ri.subtotal
  FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
  UNION ALL
  SELECT 'adjust', a.product_id, a.id, a.id, 'T-' || printf('%05d', a.id), a.created_at, NULL, NULL, a.note,
         a.delta, NULL, NULL
  FROM stock_adjustments a`

const q3 = (n: number) => Math.round(n * 1000) / 1000

// Davr harakati qatori. Kirim = kirim + vozvrat + tuzatish(+), chiqim = sotuv + tuzatish(−).
export type MovementRow = {
  product_id: number
  name: string
  unit: string
  category: string | null
  is_active: number
  cost_price: number
  opening: number
  income: number
  outcome: number
  closing: number
}

export async function stockMovementReport(dateFrom: string, dateTo: string): Promise<MovementRow[]> {
  const d = await db()
  const rows = await d.select<(Omit<MovementRow, 'opening' | 'closing'> & { stock: number; after_net: number; moves: number })[]>(
    `WITH prm AS (SELECT date(?) f, date(?) t), mv AS (${MOVES_SQL})
     SELECT p.id product_id, p.name, p.unit, c.name category, p.is_active, p.cost_price, p.stock,
       COALESCE(SUM(CASE WHEN date(mv.at) > prm.t THEN mv.delta END), 0) after_net,
       COALESCE(SUM(CASE WHEN date(mv.at) BETWEEN prm.f AND prm.t AND mv.delta > 0 THEN mv.delta END), 0) income,
       COALESCE(SUM(CASE WHEN date(mv.at) BETWEEN prm.f AND prm.t AND mv.delta < 0 THEN -mv.delta END), 0) outcome,
       COUNT(CASE WHEN date(mv.at) BETWEEN prm.f AND prm.t THEN 1 END) moves
     FROM products p CROSS JOIN prm
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN mv ON mv.pid = p.id
     GROUP BY p.id
     ORDER BY p.name`,
    [dateFrom, dateTo],
  )
  return rows
    .map(({ stock, after_net, moves, ...r }) => {
      const closing = q3(stock - after_net)
      return { ...r, income: q3(r.income), outcome: q3(r.outcome), opening: q3(closing - r.income + r.outcome), closing, moves }
    })
    // Panda bilan bir qoida: davr oxirida qoldig'i bor yoki davrda harakati bo'lganlar.
    .filter((r) => r.closing !== 0 || r.moves > 0)
    .map(({ moves: _, ...r }) => r)
}

export type MoveKind = 'receipt' | 'sale' | 'return' | 'adjust'
export type ProductMove = {
  key: string
  kind: MoveKind
  doc_id: number
  number: string
  at: string
  day: string
  /** Kontragent: kirimda ta'minotchi matni, sotuv/vozvratda mijoz. */
  party: string | null
  /** Kontragent filtri kaliti: `s:<nomi>` — ta'minotchi, `c:<id>` — mijoz. */
  party_key: string | null
  comment: string | null
  /** Ishorali: kirim/vozvrat +, sotuv −, tuzatish ±. */
  delta: number
  price: number | null
  amount: number | null
  /** Shu hujjatdan keyingi qoldiq — butun tarixdan, filtrga qaramaydi. */
  balance: number
}

// Mahsulotning butun tarixi, eskidan yangiga. Bir kun ichida avval kirim, keyin chiqim
// (Panda qoidasi): o'tgan kunga yozilgan kirim (peshin UTC) o'sha kunning ertalabki
// sotuvlaridan keyin tushib, qoldiqda bo'lmagan "minus" ko'rsatmasin.
export async function productMoves(productId: number, walkInLabel: string): Promise<ProductMove[]> {
  const d = await db()
  const rows = await d.select<(Omit<ProductMove, 'key' | 'party' | 'party_key' | 'balance'> & {
    line_id: number; supplier: string | null; customer_id: number | null; customer_name: string | null; is_walk_in: number | null; run: number
  })[]>(
    `WITH mv AS (${MOVES_SQL}),
     ord AS (
       SELECT mv.*, date(mv.at) day,
              SUM(mv.delta) OVER (ORDER BY date(mv.at), (mv.delta < 0), mv.at, mv.kind, mv.line_id ROWS UNBOUNDED PRECEDING) run,
              ROW_NUMBER() OVER (ORDER BY date(mv.at), (mv.delta < 0), mv.at, mv.kind, mv.line_id) seq
       FROM mv WHERE mv.pid = ?
     )
     SELECT ord.kind, ord.doc_id, ord.line_id, ord.number, ord.at, ord.day, ord.supplier, ord.customer_id, ord.comment,
            ord.delta, ord.price, ord.amount, ord.run, c.name customer_name, c.is_walk_in
     FROM ord LEFT JOIN customers c ON c.id = ord.customer_id
     ORDER BY ord.seq`,
    [productId],
  )
  const p = await d.select<{ stock: number }[]>('SELECT stock FROM products WHERE id = ?', [productId])
  const total = rows.length ? rows[rows.length - 1].run : 0
  const offset = (p[0]?.stock ?? 0) - total
  return rows.map((r) => {
    const supplier = r.supplier?.trim() || null
    const party = r.kind === 'receipt' ? supplier : r.customer_id ? (r.is_walk_in ? walkInLabel : r.customer_name) : null
    const party_key = r.kind === 'receipt' ? (supplier ? `s:${supplier}` : null) : r.customer_id ? `c:${r.customer_id}` : null
    return {
      key: `${r.kind}:${r.line_id}`,
      kind: r.kind,
      doc_id: r.doc_id,
      number: r.number,
      at: r.at,
      day: r.day,
      party,
      party_key,
      comment: r.comment?.trim() || null,
      delta: q3(r.delta),
      price: r.price,
      amount: r.amount,
      balance: q3(offset + r.run),
    }
  })
}

export type MoveSummary = {
  opening: number
  closing: number
  income: number
  income_amount: number
  income_count: number
  outcome: number
  outcome_amount: number
  outcome_count: number
}

// Kartochkaning davr yig'indisi — filtrsiz, Davr harakati qatoriga aynan teng.
// `moves` — productMoves() natijasi (balans ustuni orqaga tiklangan).
export function moveSummary(moves: ProductMove[], dateFrom: string, dateTo: string, currentStock: number): MoveSummary {
  const after = moves.filter((m) => m.day > dateTo).reduce((s, m) => s + m.delta, 0)
  const inside = moves.filter((m) => m.day >= dateFrom && m.day <= dateTo)
  const ins = inside.filter((m) => m.delta > 0)
  const outs = inside.filter((m) => m.delta < 0)
  const closing = q3(currentStock - after)
  const income = q3(ins.reduce((s, m) => s + m.delta, 0))
  const outcome = q3(-outs.reduce((s, m) => s + m.delta, 0))
  return {
    opening: q3(closing - income + outcome),
    closing,
    income,
    income_amount: ins.reduce((s, m) => s + (m.amount ?? 0), 0),
    income_count: ins.length,
    outcome,
    outcome_amount: outs.reduce((s, m) => s + (m.amount ?? 0), 0),
    outcome_count: outs.length,
  }
}
