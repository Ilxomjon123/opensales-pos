use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Offline POS — SQLite sxema (birinchi ishga tushishda yaratiladi).
    let migrations = vec![
    Migration {
        version: 1,
        description: "create_pos_schema",
        sql: r#"
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
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  is_walk_in INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  opening_cash INTEGER NOT NULL DEFAULT 0,
  closing_cash INTEGER,
  status TEXT NOT NULL DEFAULT 'open'
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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'dona',
  subtotal INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 2,
        description: "customer_is_active",
        sql: "ALTER TABLE customers ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 3,
        description: "customer_payments",
        sql: r#"
CREATE TABLE IF NOT EXISTS customer_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cust_pay ON customer_payments(customer_id);
        "#,
        kind: MigrationKind::Up,
    },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:pos.db", migrations)
                .build(),
        )
        .setup(|app| {
            // Release'da ham log — faylga yoziladi (Win: %APPDATA%\uz.opensales.pos\logs\,
            // mac: ~/Library/Logs/uz.opensales.pos/). Qotish/xatolarni tashxislash uchun.
            // Default targetlar: LogDir (fayl "OpenSales POS.log") + Stdout. Bitta fayl.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .max_file_size(2_000_000)
                    .build(),
            )?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
