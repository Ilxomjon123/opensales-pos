import Database from '@tauri-apps/plugin-sql'

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
  if ((r[0]?.c ?? 0) > 0) throw new Error("Bu kategoriyada mahsulotlar bor — avval ularni o'chiring yoki boshqa kategoriyaga o'tkazing")
  await d.execute('DELETE FROM categories WHERE id = ?', [id])
}

// ---- Mahsulotlar ----
export async function listProducts(activeOnly = true): Promise<Product[]> {
  const d = await db()
  const where = activeOnly ? 'WHERE is_active = 1' : ''
  return d.select<Product[]>(`SELECT * FROM products ${where} ORDER BY name`)
}
export async function saveProduct(p: Partial<Product> & { name: string; price: number }): Promise<void> {
  const d = await db()
  const barcode = p.barcode?.trim() || null
  // Bitta shtrix/QR kod ikki mahsulotга qo'yilmasin (tahrirда o'zini hisobламaymiz).
  if (barcode) {
    const dup = await d.select<{ id: number; name: string }[]>(
      'SELECT id, name FROM products WHERE barcode = ? AND id != ? LIMIT 1',
      [barcode, p.id ?? 0],
    )
    if (dup[0]) throw new Error(`Bu kod allaqachon "${dup[0].name}" mahsulotiда ishlatilgan`)
  }
  const barcodeType = barcode ? (p.barcode_type || null) : null
  if (p.id) {
    await d.execute(
      'UPDATE products SET category_id=?, name=?, price=?, cost_price=?, stock=?, unit=?, image=?, barcode=?, barcode_type=? WHERE id=?',
      [p.category_id ?? null, p.name, p.price, p.cost_price ?? 0, p.stock ?? 0, p.unit ?? 'dona', p.image ?? null, barcode, barcodeType, p.id],
    )
  } else {
    await d.execute(
      'INSERT INTO products(category_id, name, price, cost_price, stock, unit, image, barcode, barcode_type) VALUES(?,?,?,?,?,?,?,?,?)',
      [p.category_id ?? null, p.name, p.price, p.cost_price ?? 0, p.stock ?? 0, p.unit ?? 'dona', p.image ?? null, barcode, barcodeType],
    )
  }
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
  if ((sales[0]?.c ?? 0) > 0) throw new Error("Bu mahsulot sotuvlarda bor — o'chirib bo'lmaydi, deaktiv qiling")
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
  if (c.is_walk_in) throw new Error("Anonim mijozni o'chirib bo'lmaydi")
  const sales = await d.select<{ c: number }[]>('SELECT COUNT(*) c FROM sales WHERE customer_id = ?', [id])
  if ((sales[0]?.c ?? 0) > 0) throw new Error("Sotuvlari bor — deaktiv qiling")
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

// Tizim ichidagi sof harakat: qabul qilingan to'lovlar − berilgan qarzlar.
// Saldo shu + dastlabki saldodan iborat (invariant: balance = opening_balance + movements).
export async function customerMovements(customerId: number): Promise<number> {
  const d = await db()
  const r = await d.select<{ pays: number; debts: number }[]>(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = ?), 0) pays,
       COALESCE((SELECT SUM(debt_amount) FROM sales WHERE customer_id = ?), 0) debts`,
    [customerId, customerId],
  )
  return (r[0]?.pays ?? 0) - (r[0]?.debts ?? 0)
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
  const sh = await d.select<Shift[]>('SELECT opening_cash FROM shifts WHERE id = ?', [shiftId])
  const s = r[0]
  return {
    sales_count: s.sales_count,
    total_sales: s.total_sales,
    total_cash: s.total_cash,
    total_card: s.total_card,
    total_debt: s.total_debt,
    expected_cash: (sh[0]?.opening_cash ?? 0) + s.total_cash,
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
  if (!cust) throw new Error('Mijoz topilmadi')

  const subtotal = input.items.reduce((s, it) => s + Math.round(it.qty * it.price), 0)
  const discount = Math.min(Math.max(0, input.discount), subtotal)
  const total = Math.max(0, subtotal - discount)
  const paidCash = Math.max(0, input.paidCash)
  const paidCard = Math.max(0, input.paidCard)
  const paid = paidCash + paidCard
  const debt = Math.max(0, total - paid)

  if (debt > 0 && cust.is_walk_in) throw new Error("Yo'l-yo'lakay xaridorga qarzga bo'lmaydi")

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
export type SalesFilter = { search?: string; paymentStatus?: string; productId?: number; customerId?: number; dateFrom?: string; dateTo?: string }
export async function listSales(f: SalesFilter = {}): Promise<(Sale & { items: SaleItem[]; customer_name: string | null })[]> {
  const d = await db()
  const where: string[] = []
  const args: any[] = []
  if (f.paymentStatus) { where.push('s.payment_status = ?'); args.push(f.paymentStatus) }
  if (f.search) { where.push('s.receipt_number LIKE ?'); args.push(`%${f.search}%`) }
  if (f.dateFrom) { where.push("date(s.created_at) >= date(?)"); args.push(f.dateFrom) }
  if (f.dateTo) { where.push("date(s.created_at) <= date(?)"); args.push(f.dateTo) }
  if (f.productId) { where.push('s.id IN (SELECT sale_id FROM sale_items WHERE product_id = ?)'); args.push(f.productId) }
  if (f.customerId) { where.push('s.customer_id = ?'); args.push(f.customerId) }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const sales = await d.select<(Sale & { customer_name: string | null })[]>(
    `SELECT s.*, c.name customer_name FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ${w} ORDER BY s.id DESC LIMIT 200`,
    args,
  )
  const out = []
  for (const s of sales) {
    const items = await d.select<SaleItem[]>('SELECT * FROM sale_items WHERE sale_id = ?', [s.id])
    out.push({ ...s, items })
  }
  return out
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
