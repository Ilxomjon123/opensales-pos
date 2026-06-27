use tauri_plugin_sql::{Migration, MigrationKind};
use std::process::Command;

// Tizimда o'rnatilган printerlar ro'yxati (browsersiz pechat uchun tanlash).
#[tauri::command]
fn list_printers() -> Vec<String> {
    #[cfg(not(target_os = "windows"))]
    {
        // CUPS: `lpstat -e` har qatorда bitta printer nomи.
        if let Ok(out) = Command::new("lpstat").arg("-e").output() {
            return String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
        Vec::new()
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Printer | Select-Object -ExpandProperty Name"])
            .output()
        {
            return String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
        Vec::new()
    }
}

// Faylни (PNG/PDF) to'g'ridan-to'g'ri printerга yuboradi — brauzersiz.
// printer bo'sh bo'lsa standart printer ishlatiladi.
#[tauri::command]
fn print_file(path: String, printer: Option<String>, copies: Option<u32>) -> Result<(), String> {
    let n = copies.unwrap_or(1).max(1);
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("lp");
        if let Some(p) = printer.as_ref() {
            if !p.is_empty() {
                cmd.arg("-d").arg(p);
            }
        }
        if n > 1 {
            cmd.arg("-n").arg(n.to_string());
        }
        cmd.arg(&path);
        let status = cmd.status().map_err(|e| format!("lp ishga tushmadi: {e}"))?;
        if !status.success() {
            return Err("Printerга yuborishда xato (lp)".into());
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // mspaint /pt <fayl> <printer> — ko'rsatilган printerга rasm chop etadi (oynasiz).
        for _ in 0..n {
            let mut cmd = Command::new("mspaint");
            match printer.as_ref() {
                Some(p) if !p.is_empty() => {
                    cmd.args(["/pt", &path, p]);
                }
                _ => {
                    cmd.args(["/p", &path]);
                }
            }
            cmd.status().map_err(|e| format!("mspaint ishga tushmadi: {e}"))?;
        }
        Ok(())
    }
}

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
    Migration {
        version: 4,
        description: "customer_opening_balance",
        // Tizim o'rnatilgunga qadar bo'lgan saldo (dastlabki). balance = opening_balance + (to'lovlar − qarzlar).
        sql: "ALTER TABLE customers ADD COLUMN opening_balance INTEGER NOT NULL DEFAULT 0;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 5,
        description: "sale_item_cost_price",
        // Tannarxni HAR sotuvda muzlatib saqlash. Keyin mahsulot tannarxi o'zgarsa eski
        // sotuvlar foydasi o'zgarmaydi. Eski qatorlar 0 bo'lib qoladi (tarixiy tannarx noma'lum).
        sql: "ALTER TABLE sale_items ADD COLUMN cost_price INTEGER NOT NULL DEFAULT 0;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 6,
        description: "product_barcode",
        // Shtrix/QR kod orqali mahsulotni topish. Bo'sh bo'lishi mumkin. Tezkor qidiruv uchun indeks.
        sql: "ALTER TABLE products ADD COLUMN barcode TEXT;\nCREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 7,
        description: "product_barcode_unique",
        // Bitta shtrix/QR kod faqat bitta mahsulotга. Partial — NULL (kodsiz) mahsulotlar cheklanmaydi.
        // v6'да barcode endi qo'shilgan → mavjud bazaларда hammasi NULL, index muammosiz yaratiladi.
        sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique ON products(barcode) WHERE barcode IS NOT NULL;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 8,
        description: "product_barcode_type",
        // Skan qilingan kodning simbologiyasi (QR_CODE, DATA_MATRIX, EAN_13, ...).
        // Yorliq AYNAN shu turда chop etilsin. NULL = auto (kod tarkibiga qarab).
        sql: "ALTER TABLE products ADD COLUMN barcode_type TEXT;",
        kind: MigrationKind::Up,
    },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:pos.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![list_printers, print_file])
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
            // Desktop: auto-update + process (restart)
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
