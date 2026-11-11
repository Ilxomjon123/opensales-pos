import type { Sql } from './sql'

// Do'kon bazasi sxemasi. Desktop pos-tauri yakuniy sxemasi (src-tauri/src/lib.rs v1..v11,
// returns.rs RETURNS_SCHEMA_SQL, stock.rs STOCK_SCHEMA_SQL) ustun-ustun bir xil — keyin
// desktop pos.db'ni bulutga import qilish mumkin bo'lsin. Bulutga xos qo'shimchalar:
//   - `user_id` (Telegram user id) — kim yozgani; import qilingan yozuvlarda NULL;
//   - members / meta / idempotency / product_images jadvallari.
//
// QOIDA (desktop bilan bir xil): eski migratsiyani TAHRIRLAMA — faqat yangi versiya qo'sh.

const V1 = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  cost_price INTEGER NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'dona',
  image TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  barcode TEXT,
  barcode_type TEXT
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  is_walk_in INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  opening_balance INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  opening_cash INTEGER NOT NULL DEFAULT 0,
  closing_cash INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT NOT NULL,
  shift_id INTEGER REFERENCES shifts(id),
  customer_id INTEGER REFERENCES customers(id),
  total INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  paid_cash INTEGER NOT NULL DEFAULT 0,
  paid_card INTEGER NOT NULL DEFAULT 0,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  debt_amount INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'paid',
  note TEXT,
  created_at TEXT NOT NULL,
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'dona',
  subtotal INTEGER NOT NULL,
  cost_price INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS customer_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  note TEXT,
  created_at TEXT NOT NULL,
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'Boshqa',
  note TEXT,
  shift_id INTEGER,
  created_at TEXT NOT NULL,
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS sale_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  shift_id INTEGER REFERENCES shifts(id),
  customer_id INTEGER REFERENCES customers(id),
  return_number TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  refund_cash INTEGER NOT NULL DEFAULT 0 CHECK (refund_cash >= 0),
  refund_card INTEGER NOT NULL DEFAULT 0 CHECK (refund_card >= 0),
  refund_balance INTEGER NOT NULL DEFAULT 0 CHECK (refund_balance >= 0),
  reason TEXT,
  created_at TEXT NOT NULL,
  user_id INTEGER,
  CHECK (refund_cash + refund_card + refund_balance = amount)
);
CREATE TABLE IF NOT EXISTS sale_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  cost_price INTEGER NOT NULL DEFAULT 0,
  qty REAL NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL DEFAULT 'dona',
  subtotal INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT NOT NULL,
  supplier TEXT,
  note TEXT,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  void_reason TEXT,
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS stock_receipt_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'dona',
  qty REAL NOT NULL CHECK (qty > 0),
  cost_price INTEGER NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  subtotal INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  cost_before REAL NOT NULL DEFAULT 0,
  cost_after INTEGER NOT NULL DEFAULT 0,
  price_before REAL,
  sale_price INTEGER
);
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'dona',
  qty_before REAL NOT NULL,
  qty_after REAL NOT NULL,
  delta REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',
  note TEXT,
  created_at TEXT NOT NULL,
  user_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_receipt ON sales(receipt_number);
CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_cust_pay ON customer_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at);
CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_shift ON sale_returns(shift_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_customer ON sale_returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_created ON sale_returns(created_at);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_return ON sale_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_sale_item ON sale_return_items(sale_item_id);
CREATE INDEX IF NOT EXISTS idx_stock_receipts_received ON stock_receipts(received_at);
CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_receipt ON stock_receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_product ON stock_receipt_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product ON stock_adjustments(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_created ON stock_adjustments(created_at);
-- Har kassirda bitta ochiq smena (desktop'da bitta kassa = bitta smena edi).
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_open_user ON shifts(user_id) WHERE status = 'open';

-- Bulutga xos jadvallar
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS members (
  uid INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'cashier')),
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT NOT NULL,
  uid INTEGER NOT NULL,
  op TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (uid, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency(created_at);
CREATE TABLE IF NOT EXISTS product_images (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

// V2: AI yordamchisi qoralamalari (matn/ovozdan tahlil → tasdiqlashni kutadi). Yozuvning o'zi
// tasdiqlangach oddiy op orqali; bu jadval — qoralama va audit (nima aytildi, nima yozildi).
const V2 = `
CREATE TABLE assistant_drafts (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'applied', 'cancelled')),
  transcript TEXT NOT NULL,
  draft TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX idx_assistant_drafts_created ON assistant_drafts(created_at);
`

// V3: yordamchi suhbatlari (ilovadagi chatlar tarixi). Chat = shu chatdagi qoralamalar ketma-ketligi
// (har xabar — bitta qoralama: foydalanuvchi matni/ovozi + yordamchi javobi yoki kartasi).
const V3 = `
CREATE TABLE assistant_chats (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_assistant_chats_uid ON assistant_chats(uid, updated_at);
ALTER TABLE assistant_drafts ADD COLUMN chat_id TEXT;
ALTER TABLE assistant_drafts ADD COLUMN voice TEXT;
CREATE INDEX idx_assistant_drafts_chat ON assistant_drafts(chat_id, created_at);
`

// V4: chek rasmi (ulashish uchun, Telegram photo_url orqali o'qiydi) — 2 kun saqlanadi.
const V4 = `
CREATE TABLE receipt_images (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
`

// V5: bir nechta do'kon (2026-11-09).
//  * Katalog sinxroni (asosiy → filial): har tovar/kategoriya o'zgarishi `catalog_ver` hisoblagichini oshiradi va
//    qatorga `sync_ver` yoziladi (TRIGGER — hamma yozuv yo'li, jumladan ommaviy narx va kirimdagi narx, qamraladi);
//    o'chirishlar `catalog_tombstones` ga. Filial `catalog_cursor` dan keyingi o'zgarishlarni tortadi.
//    Faqat haqiqiy o'zgarish (WHEN) — kirimdagi qoldiq/tannarx yozuvi versiyani oshirmaydi.
//  * Ko'chirishlar (transfers) va ko'chirish kirimi belgisi (stock_receipts.transfer_id — bekor qilinmaydi).
const V5 = `
ALTER TABLE products ADD COLUMN sync_ver INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN sync_ver INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_products_sync ON products(sync_ver);
CREATE INDEX idx_categories_sync ON categories(sync_ver);
CREATE TABLE catalog_tombstones (
  kind TEXT NOT NULL CHECK (kind IN ('product', 'category')),
  id INTEGER NOT NULL,
  ver INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX idx_catalog_tombstones_ver ON catalog_tombstones(ver);
INSERT OR IGNORE INTO meta(key, value) VALUES('catalog_ver', '0');
-- Mavjud katalog: har qator bir marta versiyalanadi (filial birinchi tortishda hammasini oladi).
UPDATE categories SET sync_ver = id;
UPDATE products SET sync_ver = (SELECT COALESCE(MAX(id), 0) FROM categories) + id;
UPDATE meta SET value = CAST((SELECT COALESCE(MAX(id), 0) FROM categories) + (SELECT COALESCE(MAX(id), 0) FROM products) AS TEXT) WHERE key = 'catalog_ver';

CREATE TRIGGER trg_products_ins AFTER INSERT ON products BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'catalog_ver';
  UPDATE products SET sync_ver = (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'catalog_ver') WHERE id = NEW.id;
  DELETE FROM catalog_tombstones WHERE kind = 'product' AND id = NEW.id;
END;
CREATE TRIGGER trg_products_upd AFTER UPDATE OF category_id, name, price, unit, image, is_active, barcode, barcode_type ON products
WHEN OLD.category_id IS NOT NEW.category_id OR OLD.name IS NOT NEW.name OR OLD.price IS NOT NEW.price OR OLD.unit IS NOT NEW.unit
  OR OLD.image IS NOT NEW.image OR OLD.is_active IS NOT NEW.is_active OR OLD.barcode IS NOT NEW.barcode OR OLD.barcode_type IS NOT NEW.barcode_type
BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'catalog_ver';
  UPDATE products SET sync_ver = (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'catalog_ver') WHERE id = NEW.id;
END;
CREATE TRIGGER trg_products_del AFTER DELETE ON products BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'catalog_ver';
  INSERT OR REPLACE INTO catalog_tombstones(kind, id, ver) VALUES('product', OLD.id, (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'catalog_ver'));
END;
CREATE TRIGGER trg_categories_ins AFTER INSERT ON categories BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'catalog_ver';
  UPDATE categories SET sync_ver = (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'catalog_ver') WHERE id = NEW.id;
  DELETE FROM catalog_tombstones WHERE kind = 'category' AND id = NEW.id;
END;
CREATE TRIGGER trg_categories_upd AFTER UPDATE OF name, sort_order, is_active ON categories
WHEN OLD.name IS NOT NEW.name OR OLD.sort_order IS NOT NEW.sort_order OR OLD.is_active IS NOT NEW.is_active
BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'catalog_ver';
  UPDATE categories SET sync_ver = (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'catalog_ver') WHERE id = NEW.id;
END;
CREATE TRIGGER trg_categories_del AFTER DELETE ON categories BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'catalog_ver';
  INSERT OR REPLACE INTO catalog_tombstones(kind, id, ver) VALUES('category', OLD.id, (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'catalog_ver'));
END;

CREATE TABLE transfers (
  id TEXT PRIMARY KEY,                       -- ikki do'konda bir xil (idempotentlik kaliti)
  direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  peer_tenant TEXT NOT NULL,                 -- ikkinchi do'kon
  peer_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  items TEXT NOT NULL,                       -- JSON: [{productId, name, unit, qty, cost, barcode}]
  total_cost INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  user_id INTEGER,
  user_name TEXT,
  receipt_id INTEGER,                        -- qabul tomonda: yaratilgan kirim
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX idx_transfers_created ON transfers(created_at);
CREATE INDEX idx_transfers_pending ON transfers(status) WHERE status = 'pending';
ALTER TABLE stock_receipts ADD COLUMN transfer_id TEXT;
`

// V6 (2026-11-10, varonka): ALLAQACHON ochilgan (tenant_id bor), hali sotuvi yo'q va sozlamani o'zi tanlamagan
// do'konlarda qoldiqsiz sotish yoqiladi (ShopDO.init dagi yangi standart bilan bir xil). Yangi/bo'sh baza
// (desktop paritet testlari) va sotuvi bor yoki sozlamani qo'ygan do'kon tegilmaydi.
const V6 = `
INSERT OR IGNORE INTO settings(key, value) SELECT 'allow_negative_stock', '1'
WHERE EXISTS (SELECT 1 FROM meta WHERE key = 'tenant_id') AND NOT EXISTS (SELECT 1 FROM sales);
`

export const MIGRATIONS: { version: number; sql: string }[] = [{ version: 1, sql: V1 }, { version: 2, sql: V2 }, { version: 3, sql: V3 }, { version: 4, sql: V4 }, { version: 5, sql: V5 }, { version: 6, sql: V6 }]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/** Idempotent: yetishmagan versiyalarni tartib bilan qo'llaydi. */
export function migrate(sql: Sql): number {
  sql.script('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
  const row = sql.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
  let current = row ? Number(row.value) : 0
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    sql.tx(() => {
      sql.script(m.sql)
      sql.run("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(m.version))
    })
    current = m.version
  }
  return current
}
