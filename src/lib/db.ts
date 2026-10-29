import Database from '@tauri-apps/plugin-sql'
import { invoke } from '@tauri-apps/api/core'
import { t } from './i18n'

// Yagona SQLite ulanish. Rust migration sxemani yaratadi (lib.rs).
// Promise singleton — parallel chaqiruvlar bitta init/seed ishlatadi (race yo'q).
let _dbp: Promise<Database> | null = null

export function db(): Promise<Database> {
  if (!_dbp) {
    _dbp = (async () => {
      // Startupда SQLITE_BUSY (WAL/zaxira/parallel o'qish) bo'lishi mumkin — bir necha marta urinamiz.
      let lastErr: unknown
      for (let i = 0; i < 6; i++) {
        try {
          const d = await Database.load('sqlite:pos.db')
          await seedIfEmpty(d)
          await healSchema(d)
          return d
        } catch (e) {
          lastErr = e
          await new Promise((r) => setTimeout(r, 150 * (i + 1)))
        }
      }
      throw lastErr
    })()
    // MUHIM: rad etilgan promise'ni cache'da qoldirmaymiz — aks holda bitta vaqtinchalik
    // xato butun sessiya DB'ni o'ldiradi (license "expired", Device ID bo'sh ko'rinadi).
    _dbp.catch(() => { _dbp = null })
  }
  return _dbp
}

// Sxemani migration holatидан qat'i nazar to'g'rilaydi (idempotent). Migration bloklansa
// (mas. v7 unique index eski dublikat barcodeда yiqilса → v8/v9 qo'llanmaydi) ham
// dastur ishlaydi. CLAUDE.md: eski migration tahrirlanmaydi — bu JS self-heal.
async function healSchema(d: Database): Promise<void> {
  // 1) products yangi ustunlari (v6/v8 bloklangan bo'lsa)
  const cols = await d.select<{ name: string }[]>('PRAGMA table_info(products)')
  const has = (c: string) => cols.some((x) => x.name === c)
  if (!has('barcode')) await d.execute('ALTER TABLE products ADD COLUMN barcode TEXT')
  if (!has('barcode_type')) await d.execute('ALTER TABLE products ADD COLUMN barcode_type TEXT')
  // 2) dublikat barcode'larni tozalash (eng kichik id qoladi) — v7 unique index keyingi
  //    ishga tushishda muvaffaqiyatli bo'ladi va bu yerда unique index ham yaratiladi.
  await d.execute(
    `UPDATE products SET barcode = NULL
     WHERE barcode IS NOT NULL AND id NOT IN (
       SELECT MIN(id) FROM products WHERE barcode IS NOT NULL GROUP BY barcode
     )`,
  )
  await d.execute('CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)')
  try { await d.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique ON products(barcode) WHERE barcode IS NOT NULL') } catch { /* eski sqlite partial index'ни qo'llamasa — app darajasидаgi tekshiruv yetarli */ }
  // 3) expenses jadvali (v9 bloklangan bo'lsa)
  await d.execute(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'Boshqa',
    note TEXT,
    shift_id INTEGER,
    created_at TEXT NOT NULL
  )`)
  await d.execute('CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at)')
  // 4) vozvrat jadvallari (v10 tiqilgan bazalarda). DDL bitta joyda — Rust returns.rs;
  //    pool shu paytda ro'yxatda (Database.load tugagan). Yiqilsa dastur ochilaversin —
  //    faqat vozvrat ishlamaydi, sababi logда qoladi.
  try { await invoke('ensure_returns_schema') } catch (e) { console.error('ensure_returns_schema:', e) }
  // 5) kirim + qoldiq tuzatish jadvallari (v11) — DDL Rust stock.rs'da, xuddi shunday.
  try { await invoke('ensure_stock_schema') } catch (e) { console.error('ensure_stock_schema:', e) }
}

// ---- Turlar ----
export type Category = { id: number; name: string; sort_order: number; is_active: number }
export type Product = {
  id: number
  category_id: number | null
  name: string
  price: number
  cost_price: number
  stock: number
  unit: string
  image: string | null
  barcode: string | null
  barcode_type: string | null
  is_active: number
}
export type Customer = { id: number; name: string; phone: string | null; balance: number; opening_balance: number; is_walk_in: number; is_active: number }
export type Expense = { id: number; amount: number; category: string; note: string | null; shift_id: number | null; created_at: string }
export type Shift = {
  id: number
  opened_at: string
  closed_at: string | null
  opening_cash: number
  closing_cash: number | null
  status: string
}
export type Sale = {
  id: number
  receipt_number: string
  shift_id: number | null
  customer_id: number | null
  total: number
  discount: number
  paid_cash: number
  paid_card: number
  paid_amount: number
  debt_amount: number
  payment_status: string
  note: string | null
  created_at: string
}
export type SaleItem = {
  id: number
  sale_id: number
  product_id: number | null
  product_name: string
  price: number
  cost_price: number
  qty: number
  unit: string
  subtotal: number
}
export type SaleReturn = {
  id: number
  sale_id: number
  shift_id: number | null
  customer_id: number | null
  return_number: string
  amount: number
  refund_cash: number
  refund_card: number
  refund_balance: number
  reason: string | null
  created_at: string
}
export type SaleReturnItem = {
  id: number
  return_id: number
  sale_item_id: number
  product_id: number | null
  product_name: string
  price: number
  cost_price: number
  qty: number
  unit: string
  subtotal: number
}
export type SaleReturnFull = SaleReturn & { items: SaleReturnItem[] }
export type CartLine = {
  product_id: number
  name: string
  unit: string
  price: number // tahrirlanadigan narx
  cost_price: number // sotuv paytidagi tannarx (muzlatiladi)
  qty: number
  stock: number
}

// ---- Sozlamalar ----
export async function getSetting(key: string, fallback = ''): Promise<string> {
  const d = await db()
  const r = await d.select<{ value: string }[]>('SELECT value FROM settings WHERE key = ?', [key])
  return r[0]?.value ?? fallback
}
export async function setSetting(key: string, value: string): Promise<void> {
  const d = await db()
  await d.execute(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  )
}

// ---- Kategoriyalar ----
export async function listCategories(): Promise<Category[]> {
  const d = await db()
  return d.select<Category[]>('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order, name')
}
export async function saveCategory(name: string, id?: number): Promise<void> {
  const d = await db()
  if (id) await d.execute('UPDATE categories SET name = ? WHERE id = ?', [name, id])
  else await d.execute('INSERT INTO categories(name) VALUES(?)', [name])
}
export async function deleteCategory(id: number): Promise<void> {
  const d = await db()
  const r = await d.select<{ c: number }[]>('SELECT COUNT(*) c FROM products WHERE category_id = ? AND is_active = 1', [id])
  if ((r[0]?.c ?? 0) > 0) throw new Error(t('categories.hasProducts'))
  await d.execute('DELETE FROM categories WHERE id = ?', [id])
}

// ---- Mahsulotlar ----
export async function listProducts(activeOnly = true): Promise<Product[]> {
  const d = await db()
  const where = activeOnly ? 'WHERE is_active = 1' : ''
  return d.select<Product[]>(`SELECT * FROM products ${where} ORDER BY name`)
}
// Qoldiq bu yerda YOZILMAYDI — u faqat jurnal orqali o'zgaradi (lib/stock.ts adjustProductStock,
// kirim, sotuv, vozvrat), aks holda tovar harakati hisoboti yig'ilmaydi. Yangi mahsulot 0
// qoldiq bilan yaratiladi. Qaytaradi: mahsulot id.
export async function saveProduct(p: Partial<Product> & { name: string; price: number }): Promise<number> {
  const d = await db()
  const barcode = p.barcode?.trim() || null
  if (barcode && barcode.length > 512) throw new Error(t('products.barcodeTooLong'))
  // Bitta shtrix/QR kod ikki mahsulotга qo'yilmasin (tahrirда o'zini hisobламaymiz).
  if (barcode) {
    const dup = await d.select<{ id: number; name: string }[]>(
      'SELECT id, name FROM products WHERE barcode = ? AND id != ? LIMIT 1',
      [barcode, p.id ?? 0],
    )
    if (dup[0]) throw new Error(t('products.barcodeInUse', { name: dup[0].name }))
  }
  const barcodeType = barcode ? (p.barcode_type || null) : null
  if (p.id) {
    await d.execute(
      'UPDATE products SET category_id=?, name=?, price=?, cost_price=?, unit=?, image=?, barcode=?, barcode_type=? WHERE id=?',
      [p.category_id ?? null, p.name, p.price, p.cost_price ?? 0, p.unit ?? 'dona', p.image ?? null, barcode, barcodeType, p.id],
    )
    return p.id
  }
  const r = await d.execute(
    'INSERT INTO products(category_id, name, price, cost_price, stock, unit, image, barcode, barcode_type) VALUES(?,?,?,?,0,?,?,?,?)',
    [p.category_id ?? null, p.name, p.price, p.cost_price ?? 0, p.unit ?? 'dona', p.image ?? null, barcode, barcodeType],
  )
  return r.lastInsertId as number
}

// Shtrix/QR kod bo'yicha aktiv mahsulot topish (savatga qo'shish uchun). Topilmasa null.
export async function findProductByBarcode(code: string): Promise<Product | null> {
  const d = await db()
  const c = code.trim()
  if (!c) return null
  const r = await d.select<Product[]>('SELECT * FROM products WHERE barcode = ? AND is_active = 1 LIMIT 1', [c])
  return r[0] ?? null
}
export async function setProductActive(id: number, active: boolean): Promise<void> {
  const d = await db()
  await d.execute('UPDATE products SET is_active = ? WHERE id = ?', [active ? 1 : 0, id])
}
export async function deleteProduct(id: number): Promise<void> {
  const d = await db()
  const sales = await d.select<{ c: number }[]>('SELECT COUNT(*) c FROM sale_items WHERE product_id = ?', [id])
  if ((sales[0]?.c ?? 0) > 0) throw new Error(t('products.hasSales'))
  const receipts = await d.select<{ c: number }[]>('SELECT COUNT(*) c FROM stock_receipt_items WHERE product_id = ?', [id])
  if ((receipts[0]?.c ?? 0) > 0) throw new Error(t('products.hasReceipts'))
  await d.execute('DELETE FROM products WHERE id = ?', [id])
}

// ---- Narxlarni ommaviy o'zgartirish (backend BulkPriceService porti) ----
// scope: hammasi yoki bitta kategoriya. mode: foiz yoki qiymat. direction: oshirish/kamaytirish.
export type BulkPriceParams = {
  scope: 'all' | 'category'
  categoryId?: number | null
  mode: 'percent' | 'amount'
  direction: 'up' | 'down'
  value: number
}
export type BulkPricePreviewRow = { id: number; name: string; old_price: number; new_price: number }

function bulkWhere(params: BulkPriceParams): { sql: string; args: any[] } {
  if (params.scope === 'category' && params.categoryId) return { sql: 'WHERE category_id = ?', args: [params.categoryId] }
  return { sql: '', args: [] }
}
function applyBulkDelta(cur: number, params: BulkPriceParams): number {
  const sign = params.direction === 'up' ? 1 : -1
  const v = Math.max(0, params.value || 0)
  if (params.mode === 'percent') return Math.max(0, Math.round(cur * (1 + (sign * v) / 100)))
  return Math.max(0, Math.round(cur + sign * v))
}
// Oldindan ko'rish: nechta mahsulot ta'sirlanadi + birinchi N tasining eski/yangi narxi.
export async function bulkPricePreview(params: BulkPriceParams, limit = 12): Promise<{ count: number; preview: BulkPricePreviewRow[] }> {
  const d = await db()
  const { sql, args } = bulkWhere(params)
  const rows = await d.select<{ id: number; name: string; price: number }[]>(`SELECT id, name, price FROM products ${sql} ORDER BY name`, args)
  return {
    count: rows.length,
    preview: rows.slice(0, limit).map((p) => ({ id: p.id, name: p.name, old_price: p.price, new_price: applyBulkDelta(p.price, params) })),
  }
}
// Qo'llash: bitta UPDATE bilan, narx 0 dan past bo'lmaydi. O'zgartirilgan qatorlar sonini qaytaradi.
export async function bulkAdjustPrices(params: BulkPriceParams): Promise<number> {
  const d = await db()
  const { sql, args } = bulkWhere(params)
  const sign = params.direction === 'up' ? 1 : -1
  const v = Math.max(0, params.value || 0)
  let expr: string
  if (params.mode === 'percent') {
    const factor = 1 + (sign * v) / 100
    if (!Number.isFinite(factor)) return 0
    expr = `CAST(ROUND(price * ${factor}) AS INTEGER)`
  } else {
    const delta = Math.round(sign * v)
    expr = `CAST(ROUND(price + (${delta})) AS INTEGER)`
  }
  const res = await d.execute(`UPDATE products SET price = CASE WHEN ${expr} < 0 THEN 0 ELSE ${expr} END ${sql}`, args)
  return (res.rowsAffected as number) ?? 0
}

// ---- Mijozlar ----
export async function listCustomers(activeOnly = false): Promise<Customer[]> {
  const d = await db()
  const where = activeOnly ? 'WHERE is_active = 1' : ''
  return d.select<Customer[]>(`SELECT * FROM customers ${where} ORDER BY is_walk_in DESC, name`)
}
export async function setCustomerActive(id: number, active: boolean): Promise<void> {
  const d = await db()
  await d.execute('UPDATE customers SET is_active = ? WHERE id = ?', [active ? 1 : 0, id])
}
export async function deleteCustomer(id: number): Promise<void> {
  const d = await db()
  const c = (await d.select<Customer[]>('SELECT * FROM customers WHERE id = ?', [id]))[0]
  if (!c) return
  if (c.is_walk_in) throw new Error(t('customers.cannotDeleteWalkIn'))
  const sales = await d.select<{ c: number }[]>('SELECT COUNT(*) c FROM sales WHERE customer_id = ?', [id])
  if ((sales[0]?.c ?? 0) > 0) throw new Error(t('customers.hasSales'))
  await d.execute('DELETE FROM customers WHERE id = ?', [id])
}
export async function getCustomer(id: number): Promise<Customer | null> {
  const d = await db()
  const r = await d.select<Customer[]>('SELECT * FROM customers WHERE id = ?', [id])
  return r[0] ?? null
}
export async function customerSales(id: number): Promise<Sale[]> {
  const d = await db()
  return d.select<Sale[]>('SELECT * FROM sales WHERE customer_id = ? ORDER BY id DESC', [id])
}
export type CustomerPayment = { id: number; customer_id: number; amount: number; method: string; note: string | null; created_at: string }
export async function customerPayments(id: number): Promise<CustomerPayment[]> {
  const d = await db()
  return d.select<CustomerPayment[]>('SELECT * FROM customer_payments WHERE customer_id = ? ORDER BY id DESC', [id])
}
// Mijozdan to'lov qabul qilish — balans oshadi (qarz kamayadi).
export async function recordCustomerPayment(customerId: number, amount: number, method: string, note?: string): Promise<void> {
  const d = await db()
  const a = Math.max(0, Math.round(amount))
  if (a === 0) return
  await d.execute('INSERT INTO customer_payments(customer_id, amount, method, note, created_at) VALUES(?,?,?,?,?)', [customerId, a, method, note ?? null, new Date().toISOString()])
  await d.execute('UPDATE customers SET balance = balance + ? WHERE id = ?', [a, customerId])
}
export async function saveCustomer(name: string, phone: string | null, id?: number): Promise<number> {
  const d = await db()
  if (id) {
    await d.execute('UPDATE customers SET name=?, phone=? WHERE id=?', [name, phone, id])
    return id
  }
  const r = await d.execute('INSERT INTO customers(name, phone) VALUES(?, ?)', [name, phone])
  return r.lastInsertId as number
}

// Tizim ichidagi sof harakat: qabul qilingan to'lovlar + vozvratdan balansga yozilgan − berilgan qarzlar.
// Saldo shu + dastlabki saldodan iborat (invariant: balance = opening_balance + movements).
export async function customerMovements(customerId: number): Promise<number> {
  const d = await db()
  const r = await d.select<{ pays: number; debts: number; returns: number }[]>(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = ?), 0) pays,
       COALESCE((SELECT SUM(debt_amount) FROM sales WHERE customer_id = ?), 0) debts,
       COALESCE((SELECT SUM(refund_balance) FROM sale_returns WHERE customer_id = ?), 0) returns`,
    [customerId, customerId, customerId],
  )
  return (r[0]?.pays ?? 0) + (r[0]?.returns ?? 0) - (r[0]?.debts ?? 0)
}

// Mijozning JORIY saldosini belgilash. Tizim ichidagi oldi-berdi (movements) hisobga
// olinadi; qolgan farq dastlabki saldo (tizimgacha bo'lgan) sifatida saqlanadi.
// Manfiy = qarzdor, musbat = haqdor.
export async function setCustomerBalance(customerId: number, targetBalance: number): Promise<void> {
  const d = await db()
  const target = Math.round(targetBalance)
  const movements = await customerMovements(customerId)
  const opening = target - movements
  await d.execute('UPDATE customers SET opening_balance = ?, balance = ? WHERE id = ?', [opening, target, customerId])
}

// ---- Smena ----
export async function activeShift(): Promise<Shift | null> {
  const d = await db()
  const r = await d.select<Shift[]>("SELECT * FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1")
  return r[0] ?? null
}
export async function openShift(openingCash: number): Promise<Shift> {
  const d = await db()
  await d.execute('INSERT INTO shifts(opened_at, opening_cash, status) VALUES(?, ?, "open")', [
    new Date().toISOString(),
    openingCash,
  ])
  return (await activeShift())!
}
export async function closeShift(shiftId: number, closingCash: number): Promise<void> {
  const d = await db()
  await d.execute("UPDATE shifts SET status='closed', closed_at=?, closing_cash=? WHERE id=?", [
    new Date().toISOString(),
    closingCash,
    shiftId,
  ])
}
export async function shiftStats(shiftId: number): Promise<{
  sales_count: number
  total_sales: number
  total_cash: number
  total_card: number
  total_debt: number
  returns_count: number
  returns_total: number
  refund_cash: number
  refund_card: number
  expected_cash: number
}> {
  const d = await db()
  const r = await d.select<any[]>(
    `SELECT COUNT(*) sales_count, COALESCE(SUM(total),0) total_sales,
            COALESCE(SUM(paid_cash),0) total_cash, COALESCE(SUM(paid_card),0) total_card,
            COALESCE(SUM(debt_amount),0) total_debt
     FROM sales WHERE shift_id = ?`,
    [shiftId],
  )
  // Vozvrat sotuvning smenasiga emas, qaytarilgan paytdagi smenaga yoziladi (pul shu kassadan chiqqan).
  const rr = await d.select<{ c: number; total: number; cash: number; card: number }[]>(
    `SELECT COUNT(*) c, COALESCE(SUM(amount),0) total, COALESCE(SUM(refund_cash),0) cash, COALESCE(SUM(refund_card),0) card
     FROM sale_returns WHERE shift_id = ?`,
    [shiftId],
  )
  const sh = await d.select<Shift[]>('SELECT opening_cash FROM shifts WHERE id = ?', [shiftId])
  const s = r[0]
  const ret = rr[0] ?? { c: 0, total: 0, cash: 0, card: 0 }
  return {
    sales_count: s.sales_count,
    total_sales: s.total_sales,
    total_cash: s.total_cash,
    total_card: s.total_card,
    total_debt: s.total_debt,
    returns_count: ret.c,
    returns_total: ret.total,
    refund_cash: ret.cash,
    refund_card: ret.card,
    expected_cash: (sh[0]?.opening_cash ?? 0) + s.total_cash - ret.cash,
  }
}

// ---- Sotuv yaratish (PosSaleService TS porti) ----
export type CreateSaleInput = {
  shiftId: number
  customerId: number
  items: CartLine[]
  paidCash: number
  paidCard: number
  discount: number
  note?: string | null
}
export async function createSale(input: CreateSaleInput): Promise<Sale> {
  const d = await db()
  const cust = (await d.select<Customer[]>('SELECT * FROM customers WHERE id = ?', [input.customerId]))[0]
  if (!cust) throw new Error(t('sales.customerNotFound'))

  const subtotal = input.items.reduce((s, it) => s + Math.round(it.qty * it.price), 0)
  const discount = Math.min(Math.max(0, input.discount), subtotal)
  const total = Math.max(0, subtotal - discount)
  const paidCash = Math.max(0, input.paidCash)
  const paidCard = Math.max(0, input.paidCard)
  const paid = paidCash + paidCard
  const debt = Math.max(0, total - paid)

  if (debt > 0 && cust.is_walk_in) throw new Error(t('sales.noDebtForWalkIn'))

  const paymentStatus = debt <= 0 ? 'paid' : paid <= 0 ? 'debt' : 'partial'
  const receipt = await nextReceiptNumber(input.shiftId)
  const now = new Date().toISOString()

  // Eslatma: tauri-plugin-sql pool'da har execute alohida ulanish oladi, shuning
  // uchun qo'lda BEGIN/COMMIT ishlamaydi. Lokal bitta foydalanuvchi — ketma-ket
  // execute yetarli.
  const res = await d.execute(
    `INSERT INTO sales(receipt_number, shift_id, customer_id, total, discount, paid_cash, paid_card, paid_amount, debt_amount, payment_status, note, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [receipt, input.shiftId, input.customerId, total, discount, paidCash, paidCard, paid, debt, paymentStatus, input.note ?? null, now],
  )
  const saleId = res.lastInsertId as number

  for (const it of input.items) {
    const sub = Math.round(it.qty * it.price)
    await d.execute(
      'INSERT INTO sale_items(sale_id, product_id, product_name, price, cost_price, qty, unit, subtotal) VALUES(?,?,?,?,?,?,?,?)',
      [saleId, it.product_id, it.name, it.price, it.cost_price ?? 0, it.qty, it.unit, sub],
    )
    await d.execute('UPDATE products SET stock = stock - ? WHERE id = ?', [it.qty, it.product_id])
  }

  if (debt > 0 && !cust.is_walk_in) {
    await d.execute('UPDATE customers SET balance = balance - ? WHERE id = ?', [debt, input.customerId])
  }

  return (await d.select<Sale[]>('SELECT * FROM sales WHERE id = ?', [saleId]))[0]
}

async function nextReceiptNumber(shiftId: number): Promise<string> {
  const d = await db()
  const r = await d.select<{ c: number }[]>('SELECT COUNT(*) c FROM sales WHERE shift_id = ?', [shiftId])
  const n = (r[0]?.c ?? 0) + 1
  return `${shiftId}-${String(n).padStart(5, '0')}`
}

// ---- Sotuvlar tarixi ----
export type SalesFilter = { search?: string; paymentStatus?: string; returnedOnly?: boolean; productId?: number; customerId?: number; dateFrom?: string; dateTo?: string }
export type SaleListItem = SaleItem & { returned_qty: number }
export type SaleListRow = Sale & {
  items: SaleListItem[]
  customer_name: string | null
  is_walk_in: number | null
  returned_amount: number
  returns: SaleReturnFull[]
}
export async function listSales(f: SalesFilter = {}): Promise<SaleListRow[]> {
  const d = await db()
  const where: string[] = []
  const args: any[] = []
  if (f.paymentStatus) { where.push('s.payment_status = ?'); args.push(f.paymentStatus) }
  if (f.returnedOnly) where.push('EXISTS (SELECT 1 FROM sale_returns r WHERE r.sale_id = s.id)')
  if (f.search) { where.push('s.receipt_number LIKE ?'); args.push(`%${f.search}%`) }
  if (f.dateFrom) { where.push("date(s.created_at) >= date(?)"); args.push(f.dateFrom) }
  if (f.dateTo) { where.push("date(s.created_at) <= date(?)"); args.push(f.dateTo) }
  if (f.productId) { where.push('s.id IN (SELECT sale_id FROM sale_items WHERE product_id = ?)'); args.push(f.productId) }
  if (f.customerId) { where.push('s.customer_id = ?'); args.push(f.customerId) }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const sales = await d.select<(Sale & { customer_name: string | null; is_walk_in: number | null; returned_amount: number; returns_count: number })[]>(
    `SELECT s.*, c.name customer_name, c.is_walk_in is_walk_in,
            COALESCE((SELECT SUM(r.amount) FROM sale_returns r WHERE r.sale_id = s.id), 0) returned_amount,
            (SELECT COUNT(*) FROM sale_returns r WHERE r.sale_id = s.id) returns_count
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ${w} ORDER BY s.id DESC LIMIT 200`,
    args,
  )
  const returns = await returnsForSales(sales.filter((s) => s.returns_count > 0).map((s) => s.id))
  const out: SaleListRow[] = []
  for (const { returns_count: _, ...s } of sales) {
    const items = await d.select<SaleListItem[]>(
      `SELECT si.*, COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0) returned_qty
       FROM sale_items si WHERE si.sale_id = ? ORDER BY si.id`,
      [s.id],
    )
    out.push({ ...s, items, returns: returns.get(s.id) ?? [] })
  }
  return out
}

// Berilgan sotuvlarning vozvratlari (tovarlari bilan), sale_id bo'yicha guruhlangan. 2 ta so'rov.
async function returnsForSales(saleIds: number[]): Promise<Map<number, SaleReturnFull[]>> {
  const map = new Map<number, SaleReturnFull[]>()
  if (saleIds.length === 0) return map
  const d = await db()
  const ph = saleIds.map(() => '?').join(',')
  const rets = await d.select<SaleReturn[]>(`SELECT * FROM sale_returns WHERE sale_id IN (${ph}) ORDER BY id`, saleIds)
  const items = await d.select<SaleReturnItem[]>(
    `SELECT ri.* FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE r.sale_id IN (${ph}) ORDER BY ri.id`,
    saleIds,
  )
  const byReturn = new Map<number, SaleReturnItem[]>()
  for (const it of items) byReturn.set(it.return_id, [...(byReturn.get(it.return_id) ?? []), it])
  for (const r of rets) map.set(r.sale_id, [...(map.get(r.sale_id) ?? []), { ...r, items: byReturn.get(r.id) ?? [] }])
  return map
}

// ---- Vozvratlar bo'limi ----
export type ReturnMethod = 'cash' | 'card' | 'balance'
export type ReturnsFilter = { customerId?: number; productId?: number; dateFrom?: string; dateTo?: string; method?: ReturnMethod }
export type ReturnListRow = SaleReturn & {
  receipt_number: string
  customer_name: string | null
  is_walk_in: number | null
  items: SaleReturnItem[]
}
// Usul filtri — SQL faqat shu ro'yxatdan (foydalanuvchi matni so'rovga qo'shilmaydi).
const RETURN_METHOD_SQL: Record<ReturnMethod, string> = {
  cash: 'r.refund_cash > 0',
  card: 'r.refund_card > 0',
  balance: 'r.refund_balance > 0',
}
export async function listReturns(f: ReturnsFilter = {}): Promise<ReturnListRow[]> {
  const d = await db()
  const where: string[] = []
  const args: any[] = []
  if (f.customerId) { where.push('r.customer_id = ?'); args.push(f.customerId) }
  if (f.productId) { where.push('EXISTS (SELECT 1 FROM sale_return_items ri WHERE ri.return_id = r.id AND ri.product_id = ?)'); args.push(f.productId) }
  if (f.dateFrom) { where.push('date(r.created_at) >= date(?)'); args.push(f.dateFrom) }
  if (f.dateTo) { where.push('date(r.created_at) <= date(?)'); args.push(f.dateTo) }
  if (f.method) where.push(RETURN_METHOD_SQL[f.method])
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const rows = await d.select<Omit<ReturnListRow, 'items'>[]>(
    `SELECT r.*, s.receipt_number, c.name customer_name, c.is_walk_in is_walk_in
     FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers c ON c.id = r.customer_id
     ${w} ORDER BY r.id DESC LIMIT 500`,
    args,
  )
  const byReturn = new Map<number, SaleReturnItem[]>()
  if (rows.length) {
    const ids = rows.map((r) => r.id)
    const items = await d.select<SaleReturnItem[]>(
      `SELECT * FROM sale_return_items WHERE return_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      ids,
    )
    for (const it of items) byReturn.set(it.return_id, [...(byReturn.get(it.return_id) ?? []), it])
  }
  return rows.map((r) => ({ ...r, items: byReturn.get(r.id) ?? [] }))
}

// Mijozning vozvratlari (eng yangisi birinchi) — mijoz sahifasidagi oldi-berdi uchun.
export async function customerReturns(customerId: number): Promise<SaleReturn[]> {
  const d = await db()
  return d.select<SaleReturn[]>('SELECT * FROM sale_returns WHERE customer_id = ? ORDER BY id DESC', [customerId])
}

// ---- Mahsulot × mijoz sotuv tarixi ----
// Shu mahsulot shu mijozga qachon, qancha sonda, qaysi narxda sotilgani (eng yangisi birinchi).
export type ProductCustomerHistoryRow = {
  sale_id: number
  receipt_number: string
  created_at: string
  price: number
  qty: number
  unit: string
  subtotal: number
}
export async function productCustomerHistory(productId: number, customerId: number): Promise<ProductCustomerHistoryRow[]> {
  const d = await db()
  return d.select<ProductCustomerHistoryRow[]>(
    `SELECT s.id sale_id, s.receipt_number, s.created_at, si.price, si.qty, si.unit, si.subtotal
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE si.product_id = ? AND s.customer_id = ?
     ORDER BY s.id DESC`,
    [productId, customerId],
  )
}

// ---- Xarajatlar ----
// db() ochilishida healSchema expenses jadvalini kafolatlaydi — alohida ensure shart emas.
export type ExpenseFilter = { dateFrom?: string; dateTo?: string; category?: string }
export async function listExpenses(f: ExpenseFilter = {}): Promise<Expense[]> {
  const d = await db()
  const where: string[] = []
  const args: any[] = []
  if (f.dateFrom) { where.push('date(created_at) >= date(?)'); args.push(f.dateFrom) }
  if (f.dateTo) { where.push('date(created_at) <= date(?)'); args.push(f.dateTo) }
  if (f.category) { where.push('category = ?'); args.push(f.category) }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  return d.select<Expense[]>(`SELECT * FROM expenses ${w} ORDER BY id DESC`, args)
}
// Tanlangan sanani (YYYY-MM-DD) ISO created_at'ga aylantiradi. Bugun bo'lsa joriy vaqt,
// aks holda o'sha kun peshini (kun-chegarasi timezone siljishini oldini oladi).
// Xarajat va kirim sanasi ikkalasi ham shu.
export function dayIso(date?: string): string {
  if (!date) return new Date().toISOString()
  const today = new Date().toISOString().slice(0, 10)
  if (date === today) return new Date().toISOString()
  // Peshin UTC — date(created_at) har timezoneда aynan tanlangan kunni beradi.
  return `${date}T12:00:00.000Z`
}
// Xarajat qo'shish/tahrirlash. Joriy ochiq smenaга bog'lanadi (yangi yozuvда).
export async function saveExpense(e: { id?: number; amount: number; category: string; note?: string | null; date?: string }): Promise<void> {
  const d = await db()
  const amount = Math.max(0, Math.round(e.amount || 0))
  if (amount === 0) throw new Error(t('expenses.amountMustBePositive'))
  const category = e.category?.trim() || 'Boshqa'
  const note = e.note?.trim() || null
  const createdAt = dayIso(e.date)
  if (e.id) {
    await d.execute('UPDATE expenses SET amount=?, category=?, note=?, created_at=? WHERE id=?', [amount, category, note, createdAt, e.id])
  } else {
    const sh = await activeShift()
    await d.execute('INSERT INTO expenses(amount, category, note, shift_id, created_at) VALUES(?,?,?,?,?)',
      [amount, category, note, sh?.id ?? null, createdAt])
  }
}
export async function deleteExpense(id: number): Promise<void> {
  const d = await db()
  await d.execute('DELETE FROM expenses WHERE id = ?', [id])
}
// Davr ichidagi jami xarajat (hisobot uchun).
export async function expensesTotal(dateFrom: string, dateTo: string): Promise<number> {
  const d = await db()
  const r = await d.select<{ t: number }[]>('SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE date(created_at) BETWEEN ? AND ?', [dateFrom, dateTo])
  return r[0]?.t ?? 0
}

// ---- Boshlang'ich ma'lumot ----
async function seedIfEmpty(d: Database): Promise<void> {
  const r = await d.select<{ c: number }[]>('SELECT COUNT(*) c FROM customers')
  if ((r[0]?.c ?? 0) > 0) return

  await d.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('currency_symbol', 'so''m')")
  const defaultPin = (import.meta.env.VITE_DEFAULT_PIN ?? '1234') as string
  await d.execute('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)', ['auth_pin', defaultPin])
  await d.execute("INSERT INTO customers(name, is_walk_in) VALUES('Yo''l-yo''lakay xaridor', 1)")
  // Mahsulot va kategoriyalar bo'sh — do'kon egasi o'zi qo'shadi.
}
