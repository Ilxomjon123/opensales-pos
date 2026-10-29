//! Tovar kirimi (prixod), kirimni bekor qilish va qoldiqni qo'lda tuzatish.
//!
//! Nega Rust'da: returns.rs bilan bir xil sabab — JS'dan BEGIN/COMMIT ishlamaydi, kirim esa
//! bir nechta mahsulotning qoldig'i, tannarxi va narxini birga o'zgartiradi. Hammasi bitta
//! `BEGIN IMMEDIATE` tranzaksiyada: yarmida yiqilsa hech narsa yozilmaydi.
//!
//! Harakat jurnali: qoldiqni o'zgartiradigan har amal yozuv qoldiradi — sotuv (`sale_items`),
//! vozvrat (`sale_return_items`), kirim (`stock_receipt_items`), qo'lda tuzatish
//! (`stock_adjustments`). "Tovar harakati" hisoboti (lib/stock.ts) davr boshidagi va
//! oxiridagi qoldiqni shu to'rttasidan joriy qoldiqqa qarab orqaga tiklaydi. Shuning uchun
//! `products.stock` ga bu modul va sotuv/vozvratdan boshqa hech kim yozmasligi kerak.
//!
//! Tannarx: kirimda og'irlikli o'rtacha — (qoldiq × eski tannarx + miqdor × kirim narxi) /
//! (qoldiq + miqdor). Eski tannarx noma'lum (0) yoki qoldiq yo'q bo'lsa — kirim narxi.
//! Kirim narxi 0 bo'lsa tannarx o'zgarmaydi (kiritilmagan narx o'rtachani buzmasin).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection, SqlitePool};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::returns::DB_URL;

const QTY_SCALE: f64 = 1000.0;
const QTY_EPS: f64 = 1e-6;
const MAX_LINES: usize = 500;
const SUPPLIER_MAX_CHARS: usize = 120;
const NOTE_MAX_CHARS: usize = 500;
/// Narx/miqdor yuqori chegarasi — i64 yaxlitlash va ko'paytmada toshib ketmasin.
const AMOUNT_MAX: f64 = 1e12;

/// Kirim va tuzatish jadvallari. Migratsiya v11 VA `ensure_stock_schema` shu matnni
/// ishlatadi (eski bazalarda migratsiyalar v8 da tiqilgan — CLAUDE.md). Idempotent.
pub const STOCK_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS stock_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT NOT NULL,
  supplier TEXT,
  note TEXT,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  void_reason TEXT
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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_receipts_received ON stock_receipts(received_at);
CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_receipt ON stock_receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_product ON stock_receipt_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product ON stock_adjustments(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_created ON stock_adjustments(created_at);
"#;

/// UI'ga boradigan xato: `code` → i18n kaliti (`stock.errors.<code>`), `params` → o'rinbosarlar.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StockError {
    pub code: &'static str,
    pub params: Value,
}

impl StockError {
    fn new(code: &'static str) -> Self {
        Self { code, params: json!({}) }
    }

    fn with(code: &'static str, params: Value) -> Self {
        Self { code, params }
    }
}

impl From<sqlx::Error> for StockError {
    fn from(e: sqlx::Error) -> Self {
        log::error!("kirim: db xato: {e}");
        Self::with("db", json!({ "detail": e.to_string() }))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptLineInput {
    pub product_id: i64,
    pub qty: f64,
    pub cost_price: f64,
    /// Yangi sotuv narxi. None — narx o'zgarmaydi.
    pub sale_price: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptRequest {
    pub supplier: Option<String>,
    pub note: Option<String>,
    /// ISO vaqt (UI tanlangan kunni beradi). None — hozir.
    pub received_at: Option<String>,
    pub lines: Vec<ReceiptLineInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedReceipt {
    pub id: i64,
    pub receipt_number: String,
    pub total: i64,
    pub received_at: String,
    pub lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidedReceipt {
    pub id: i64,
    pub receipt_number: String,
    pub voided_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockAdjusted {
    pub product_id: i64,
    pub qty_before: f64,
    pub qty_after: f64,
    pub delta: f64,
    /// Farq bo'lmasa false — yozuv qo'shilmaydi.
    pub recorded: bool,
}

struct ProductRow {
    id: i64,
    name: String,
    unit: String,
    stock: f64,
    cost: f64,
    price: f64,
}

fn normalize_qty(q: f64) -> f64 {
    (q * QTY_SCALE).round() / QTY_SCALE
}

/// Bo'sh matn → None; uzunlik chegaradan oshsa xato.
fn clean_text(s: Option<&str>, max: usize, code: &'static str) -> Result<Option<String>, StockError> {
    let v = s.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    if v.as_ref().is_some_and(|x| x.chars().count() > max) {
        return Err(StockError::with(code, json!({ "max": max })));
    }
    Ok(v)
}

/// Pul qiymati: chekli, manfiy emas, butun so'mga yaxlitlanadi.
fn money(v: f64, code: &'static str, name: &str) -> Result<i64, StockError> {
    if !v.is_finite() || v < 0.0 || v > AMOUNT_MAX {
        return Err(StockError::with(code, json!({ "name": name })));
    }
    Ok(v.round() as i64)
}

/// Kirimdan keyingi tannarx (butun so'm). Modul izohidagi qoida.
fn weighted_cost(stock: f64, cost: f64, qty: f64, in_cost: i64) -> i64 {
    if in_cost <= 0 {
        return cost.round() as i64;
    }
    if stock <= QTY_EPS || cost <= 0.0 {
        return in_cost;
    }
    ((stock * cost + qty * in_cost as f64) / (stock + qty)).round() as i64
}

// Tannarx/narx INTEGER ustun, lekin eski yozuvda kasr bor (12527.2) — sqlx turini qat'iy
// tekshiradi, shuning uchun REAL qilib o'qiymiz.
async fn load_product(conn: &mut SqliteConnection, id: i64) -> Result<ProductRow, StockError> {
    let r = sqlx::query(
        "SELECT id, name, unit, CAST(stock AS REAL) stock,
                CAST(cost_price AS REAL) cost, CAST(price AS REAL) price
         FROM products WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| StockError::with("productNotFound", json!({ "productId": id })))?;
    Ok(ProductRow {
        id: r.try_get("id")?,
        name: r.try_get("name")?,
        unit: r.try_get("unit")?,
        stock: r.try_get("stock")?,
        cost: r.try_get("cost")?,
        price: r.try_get("price")?,
    })
}

async fn allow_negative_stock(conn: &mut SqliteConnection) -> Result<bool, StockError> {
    let v = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'allow_negative_stock'")
        .fetch_optional(&mut *conn)
        .await?;
    Ok(v.as_deref() == Some("1"))
}

/// Kirim sanasini SQLite'ning o'zi tekshiradi va bir xil ko'rinishga keltiradi.
/// Kelajakdagi kun rad etiladi — hisobotda hali bo'lmagan tovar qoldiqqa tushib qoladi.
async fn received_at(conn: &mut SqliteConnection, raw: Option<&str>) -> Result<String, StockError> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        let now: String = sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
            .fetch_one(&mut *conn)
            .await?;
        return Ok(now);
    };
    let r = sqlx::query(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1) iso,
                CAST(date(?1) > date('now', '+1 day') AS INTEGER) future",
    )
    .bind(raw)
    .fetch_one(&mut *conn)
    .await?;
    let iso: Option<String> = r.try_get("iso")?;
    let iso = iso.ok_or_else(|| StockError::new("invalidDate"))?;
    // +1 kun: UI kunni UTC'da beradi, mahalliy vaqt bilan bugun bo'lsa ham UTC'da ertaga
    // bo'lib qolishi mumkin. Undan uzog'i — xato.
    if r.try_get::<i64, _>("future")? != 0 {
        return Err(StockError::new("futureDate"));
    }
    Ok(iso)
}

/// Kirimni tekshiradi va yozadi. Chaqiruvchi tranzaksiya ichida chaqirishi SHART.
pub(crate) async fn create_receipt_on(
    conn: &mut SqliteConnection,
    req: &ReceiptRequest,
) -> Result<CreatedReceipt, StockError> {
    if req.lines.is_empty() {
        return Err(StockError::new("noLines"));
    }
    if req.lines.len() > MAX_LINES {
        return Err(StockError::with("tooManyLines", json!({ "max": MAX_LINES })));
    }
    let supplier = clean_text(req.supplier.as_deref(), SUPPLIER_MAX_CHARS, "supplierTooLong")?;
    let note = clean_text(req.note.as_deref(), NOTE_MAX_CHARS, "noteTooLong")?;
    let received = received_at(conn, req.received_at.as_deref()).await?;

    // Avval hammasini tekshiramiz, keyin yozamiz — xato matni aniq qatorni ko'rsatadi.
    let mut seen = HashSet::new();
    let mut lines = Vec::with_capacity(req.lines.len());
    for l in &req.lines {
        let p = load_product(conn, l.product_id).await?;
        let name = json!({ "name": p.name });
        if !seen.insert(p.id) {
            return Err(StockError::with("duplicateLine", name));
        }
        if !l.qty.is_finite() || l.qty <= 0.0 || l.qty > AMOUNT_MAX {
            return Err(StockError::with("invalidQty", name));
        }
        let qty = normalize_qty(l.qty);
        if qty <= 0.0 {
            return Err(StockError::with("invalidQty", name));
        }
        let cost = money(l.cost_price, "invalidCost", &p.name)?;
        let sale_price = l.sale_price.map(|v| money(v, "invalidPrice", &p.name)).transpose()?;
        let subtotal = (qty * cost as f64).round() as i64;
        lines.push((p, qty, cost, sale_price, subtotal));
    }
    let total = lines
        .iter()
        .try_fold(0i64, |s, l| s.checked_add(l.4))
        .ok_or_else(|| StockError::new("totalTooLarge"))?;

    let receipt_id = sqlx::query(
        "INSERT INTO stock_receipts(receipt_number, supplier, note, total, received_at, created_at)
         VALUES('', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(&supplier)
    .bind(&note)
    .bind(total)
    .bind(&received)
    .execute(&mut *conn)
    .await?
    .last_insert_rowid();
    // Raqam id'dan — AUTOINCREMENT qaytarilmaydi, ikki kirimga bir raqam tushmaydi.
    let receipt_number = format!("K-{receipt_id:05}");
    sqlx::query("UPDATE stock_receipts SET receipt_number = ? WHERE id = ?")
        .bind(&receipt_number)
        .bind(receipt_id)
        .execute(&mut *conn)
        .await?;

    for (p, qty, cost, sale_price, subtotal) in &lines {
        let cost_after = weighted_cost(p.stock, p.cost, *qty, *cost);
        // Narx o'zgarmagan bo'lsa yozmaymiz — bekor qilishda tiklanadigan narsa yo'q.
        let new_price = sale_price.filter(|v| (*v as f64 - p.price).abs() >= 0.5);
        sqlx::query(
            "INSERT INTO stock_receipt_items(receipt_id, product_id, product_name, unit, qty, cost_price,
                                             subtotal, cost_before, cost_after, price_before, sale_price)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(receipt_id)
        .bind(p.id)
        .bind(&p.name)
        .bind(&p.unit)
        .bind(qty)
        .bind(cost)
        .bind(subtotal)
        .bind(p.cost)
        .bind(cost_after)
        .bind(new_price.map(|_| p.price))
        .bind(new_price)
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "UPDATE products SET stock = stock + ?, cost_price = ?, price = COALESCE(?, price) WHERE id = ?",
        )
        .bind(qty)
        .bind(cost_after)
        .bind(new_price)
        .bind(p.id)
        .execute(&mut *conn)
        .await?;
    }

    Ok(CreatedReceipt { id: receipt_id, receipt_number, total, received_at: received, lines: lines.len() })
}

struct VoidLine {
    id: i64,
    product_id: Option<i64>,
    qty: f64,
    cost_before: f64,
    cost_after: f64,
    price_before: Option<f64>,
    sale_price: Option<f64>,
}

/// Kirimni bekor qiladi: qoldiq qaytariladi, yozuv o'chirilmaydi (`voided_at`). Tannarx/narx
/// faqat shu kirimdan keyin hech kim o'zgartirmagan bo'lsa (joriy qiymat = kirim qo'ygan
/// qiymat va keyinroq faol kirim yo'q) eski holatiga qaytadi — xato kiritilgan narx bilan
/// qilingan kirim bekor qilinganda tannarx ham tuzaladi, keyingi o'zgarishlar esa bosilmaydi.
pub(crate) async fn void_receipt_on(
    conn: &mut SqliteConnection,
    receipt_id: i64,
    reason: Option<&str>,
) -> Result<VoidedReceipt, StockError> {
    let reason = clean_text(reason, NOTE_MAX_CHARS, "noteTooLong")?;
    let r = sqlx::query("SELECT receipt_number, voided_at FROM stock_receipts WHERE id = ?")
        .bind(receipt_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| StockError::with("receiptNotFound", json!({ "receiptId": receipt_id })))?;
    let receipt_number: String = r.try_get("receipt_number")?;
    if r.try_get::<Option<String>, _>("voided_at")?.is_some() {
        return Err(StockError::with("alreadyVoided", json!({ "number": receipt_number })));
    }

    let rows = sqlx::query(
        "SELECT id, product_id, CAST(qty AS REAL) qty, CAST(cost_before AS REAL) cost_before,
                CAST(cost_after AS REAL) cost_after, CAST(price_before AS REAL) price_before,
                CAST(sale_price AS REAL) sale_price
         FROM stock_receipt_items WHERE receipt_id = ? ORDER BY id",
    )
    .bind(receipt_id)
    .fetch_all(&mut *conn)
    .await?;
    let items = rows
        .iter()
        .map(|r| {
            Ok(VoidLine {
                id: r.try_get("id")?,
                product_id: r.try_get("product_id")?,
                qty: r.try_get("qty")?,
                cost_before: r.try_get("cost_before")?,
                cost_after: r.try_get("cost_after")?,
                price_before: r.try_get("price_before")?,
                sale_price: r.try_get("sale_price")?,
            })
        })
        .collect::<Result<Vec<_>, StockError>>()?;

    let allow_negative = allow_negative_stock(conn).await?;
    for it in &items {
        let Some(pid) = it.product_id else { continue };
        let p = load_product(conn, pid).await?;
        if !allow_negative && p.stock - it.qty < -QTY_EPS {
            return Err(StockError::with(
                "stockWouldGoNegative",
                json!({ "name": p.name, "stock": normalize_qty(p.stock), "qty": it.qty, "unit": p.unit }),
            ));
        }
        let later: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM stock_receipt_items i JOIN stock_receipts r ON r.id = i.receipt_id
             WHERE i.product_id = ? AND i.id > ? AND r.voided_at IS NULL",
        )
        .bind(pid)
        .bind(it.id)
        .fetch_one(&mut *conn)
        .await?;
        let untouched = |cur: f64, set: f64| later == 0 && (cur - set).abs() < 0.5;
        let cost = if untouched(p.cost, it.cost_after) { it.cost_before } else { p.cost };
        let price = match (it.sale_price, it.price_before) {
            (Some(set), Some(before)) if untouched(p.price, set) => before,
            _ => p.price,
        };
        sqlx::query("UPDATE products SET stock = stock - ?, cost_price = ?, price = ? WHERE id = ?")
            .bind(it.qty)
            .bind(cost)
            .bind(price)
            .bind(pid)
            .execute(&mut *conn)
            .await?;
    }

    sqlx::query(
        "UPDATE stock_receipts SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), void_reason = ? WHERE id = ?",
    )
    .bind(&reason)
    .bind(receipt_id)
    .execute(&mut *conn)
    .await?;
    let voided_at: String = sqlx::query_scalar("SELECT voided_at FROM stock_receipts WHERE id = ?")
        .bind(receipt_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(VoidedReceipt { id: receipt_id, receipt_number, voided_at })
}

/// Qoldiqni berilgan qiymatga o'rnatadi va farqni jurnalga yozadi. `kind`: `initial` —
/// yangi mahsulotning boshlang'ich qoldig'i, `manual` — qo'lda tuzatish (inventarizatsiya).
pub(crate) async fn adjust_on(
    conn: &mut SqliteConnection,
    product_id: i64,
    new_stock: f64,
    kind: &str,
    note: Option<&str>,
) -> Result<StockAdjusted, StockError> {
    let kind: &'static str = match kind {
        "initial" => "initial",
        "manual" => "manual",
        _ => return Err(StockError::new("invalidKind")),
    };
    let note = clean_text(note, NOTE_MAX_CHARS, "noteTooLong")?;
    let p = load_product(conn, product_id).await?;
    if !new_stock.is_finite() || new_stock < 0.0 || new_stock > AMOUNT_MAX {
        return Err(StockError::with("invalidStock", json!({ "name": p.name })));
    }
    let after = normalize_qty(new_stock);
    let delta = normalize_qty(after - p.stock);
    if delta.abs() < QTY_EPS {
        return Ok(StockAdjusted { product_id, qty_before: p.stock, qty_after: p.stock, delta: 0.0, recorded: false });
    }
    sqlx::query("UPDATE products SET stock = ? WHERE id = ?")
        .bind(after)
        .bind(p.id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO stock_adjustments(product_id, product_name, unit, qty_before, qty_after, delta, kind, note, created_at)
         VALUES(?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(p.id)
    .bind(&p.name)
    .bind(&p.unit)
    .bind(p.stock)
    .bind(after)
    .bind(delta)
    .bind(kind)
    .bind(&note)
    .execute(&mut *conn)
    .await?;
    Ok(StockAdjusted { product_id, qty_before: p.stock, qty_after: after, delta, recorded: true })
}

pub async fn create_receipt_tx(pool: &SqlitePool, req: &ReceiptRequest) -> Result<CreatedReceipt, StockError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let out = create_receipt_on(&mut tx, req).await?;
    tx.commit().await?;
    log::info!("kirim {} · {} qator · {}", out.receipt_number, out.lines, out.total);
    Ok(out)
}

pub async fn void_receipt_tx(pool: &SqlitePool, receipt_id: i64, reason: Option<&str>) -> Result<VoidedReceipt, StockError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let out = void_receipt_on(&mut tx, receipt_id, reason).await?;
    tx.commit().await?;
    log::info!("kirim bekor {}", out.receipt_number);
    Ok(out)
}

pub async fn adjust_tx(
    pool: &SqlitePool,
    product_id: i64,
    new_stock: f64,
    kind: &str,
    note: Option<&str>,
) -> Result<StockAdjusted, StockError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let out = adjust_on(&mut tx, product_id, new_stock, kind, note).await?;
    tx.commit().await?;
    if out.recorded {
        log::info!("qoldiq tuzatish #{} · {} → {} ({kind})", out.product_id, out.qty_before, out.qty_after);
    }
    Ok(out)
}

async fn sqlite_pool(instances: &DbInstances) -> Result<SqlitePool, StockError> {
    let map = instances.0.read().await;
    match map.get(DB_URL) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err(StockError::new("dbNotLoaded")),
    }
}

#[tauri::command]
pub async fn ensure_stock_schema(instances: State<'_, DbInstances>) -> Result<(), StockError> {
    let pool = sqlite_pool(&instances).await?;
    sqlx::raw_sql(STOCK_SCHEMA_SQL).execute(&pool).await?;
    Ok(())
}

#[tauri::command]
pub async fn create_stock_receipt(
    instances: State<'_, DbInstances>,
    request: ReceiptRequest,
) -> Result<CreatedReceipt, StockError> {
    let pool = sqlite_pool(&instances).await?;
    create_receipt_tx(&pool, &request).await
}

#[tauri::command]
pub async fn void_stock_receipt(
    instances: State<'_, DbInstances>,
    receipt_id: i64,
    reason: Option<String>,
) -> Result<VoidedReceipt, StockError> {
    let pool = sqlite_pool(&instances).await?;
    void_receipt_tx(&pool, receipt_id, reason.as_deref()).await
}

#[tauri::command]
pub async fn adjust_product_stock(
    instances: State<'_, DbInstances>,
    product_id: i64,
    new_stock: f64,
    kind: String,
    note: Option<String>,
) -> Result<StockAdjusted, StockError> {
    let pool = sqlite_pool(&instances).await?;
    adjust_tx(&pool, product_id, new_stock, &kind, note.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::returns::tests::{count, customer, exec, migrated_db, open_shift, product, rt, sale, stock};

    fn line(product_id: i64, qty: f64, cost: f64, sale_price: Option<f64>) -> ReceiptLineInput {
        ReceiptLineInput { product_id, qty, cost_price: cost, sale_price }
    }

    fn receipt(lines: Vec<ReceiptLineInput>) -> ReceiptRequest {
        ReceiptRequest { supplier: Some("  Ulgurji baza ".into()), note: None, received_at: None, lines }
    }

    async fn cost(pool: &SqlitePool, pid: i64) -> f64 {
        sqlx::query_scalar("SELECT CAST(cost_price AS REAL) FROM products WHERE id = ?").bind(pid).fetch_one(pool).await.unwrap()
    }

    async fn price(pool: &SqlitePool, pid: i64) -> f64 {
        sqlx::query_scalar("SELECT CAST(price AS REAL) FROM products WHERE id = ?").bind(pid).fetch_one(pool).await.unwrap()
    }

    fn code<T: std::fmt::Debug>(r: Result<T, StockError>) -> &'static str {
        r.expect_err("xato kutilgan edi").code
    }

    #[test]
    fn receipt_adds_stock_averages_cost_and_updates_price() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            // product(): tannarx = narx / 2 → 5 000
            let a = product(p, "Choy", 10_000, 10.0).await;
            let b = product(p, "Shakar", 4_000, 0.0).await;

            let r = create_receipt_tx(p, &receipt(vec![line(a, 10.0, 7_000.0, Some(12_000.0)), line(b, 2.5, 3_000.0, None)]))
                .await
                .unwrap();
            assert_eq!(r.receipt_number, format!("K-{:05}", r.id));
            assert_eq!(r.total, 70_000 + 7_500);
            assert_eq!(r.lines, 2);
            assert_eq!(stock(p, a).await, 20.0);
            assert_eq!(stock(p, b).await, 2.5);
            // (10 × 5 000 + 10 × 7 000) / 20 = 6 000
            assert_eq!(cost(p, a).await, 6_000.0);
            // Qoldiq 0 edi — o'rtacha emas, kirim narxi.
            assert_eq!(cost(p, b).await, 3_000.0);
            assert_eq!(price(p, a).await, 12_000.0);
            assert_eq!(price(p, b).await, 4_000.0);

            let supplier: String = sqlx::query_scalar("SELECT supplier FROM stock_receipts").fetch_one(p).await.unwrap();
            assert_eq!(supplier, "Ulgurji baza");
        });
    }

    #[test]
    fn zero_incoming_cost_keeps_cost_and_unknown_old_cost_takes_incoming() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let a = product(p, "Choy", 10_000, 10.0).await;
            let b = exec(p, "INSERT INTO products(name, price, cost_price, stock) VALUES('Un', 9000, 0, 50)").await;

            create_receipt_tx(p, &receipt(vec![line(a, 5.0, 0.0, None), line(b, 10.0, 6_000.0, None)])).await.unwrap();
            assert_eq!(cost(p, a).await, 5_000.0);
            assert_eq!(stock(p, a).await, 15.0);
            assert_eq!(cost(p, b).await, 6_000.0);
        });
    }

    #[test]
    fn negative_stock_is_not_averaged_against() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let a = product(p, "Choy", 10_000, -4.0).await;
            create_receipt_tx(p, &receipt(vec![line(a, 10.0, 8_000.0, None)])).await.unwrap();
            assert_eq!(stock(p, a).await, 6.0);
            assert_eq!(cost(p, a).await, 8_000.0);
        });
    }

    #[test]
    fn invalid_receipts_are_rejected_without_writes() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let a = product(p, "Choy", 10_000, 10.0).await;
            let b = product(p, "Shakar", 4_000, 10.0).await;

            assert_eq!(code(create_receipt_tx(p, &receipt(vec![])).await), "noLines");
            assert_eq!(code(create_receipt_tx(p, &receipt(vec![line(a, 1.0, 1.0, None), line(a, 2.0, 1.0, None)])).await), "duplicateLine");
            assert_eq!(code(create_receipt_tx(p, &receipt(vec![line(a, 0.0, 1.0, None)])).await), "invalidQty");
            assert_eq!(code(create_receipt_tx(p, &receipt(vec![line(a, 0.0001, 1.0, None)])).await), "invalidQty");
            assert_eq!(code(create_receipt_tx(p, &receipt(vec![line(a, f64::NAN, 1.0, None)])).await), "invalidQty");
            assert_eq!(code(create_receipt_tx(p, &receipt(vec![line(a, 1.0, -5.0, None)])).await), "invalidCost");
            assert_eq!(code(create_receipt_tx(p, &receipt(vec![line(a, 1.0, f64::INFINITY, None)])).await), "invalidCost");
            assert_eq!(code(create_receipt_tx(p, &receipt(vec![line(a, 1.0, 1.0, Some(-1.0))])).await), "invalidPrice");
            assert_eq!(code(create_receipt_tx(p, &receipt(vec![line(9_999, 1.0, 1.0, None)])).await), "productNotFound");

            let mut long = receipt(vec![line(a, 1.0, 1.0, None)]);
            long.supplier = Some("x".repeat(SUPPLIER_MAX_CHARS + 1));
            assert_eq!(code(create_receipt_tx(p, &long).await), "supplierTooLong");

            let mut bad_date = receipt(vec![line(a, 1.0, 1.0, None)]);
            bad_date.received_at = Some("29-10-2026".into());
            assert_eq!(code(create_receipt_tx(p, &bad_date).await), "invalidDate");
            bad_date.received_at = Some("2999-01-01T12:00:00.000Z".into());
            assert_eq!(code(create_receipt_tx(p, &bad_date).await), "futureDate");

            // Ikkinchi qator yiqilsa birinchisi ham yozilmaydi.
            assert_eq!(code(create_receipt_tx(p, &receipt(vec![line(b, 3.0, 1.0, None), line(a, -1.0, 1.0, None)])).await), "invalidQty");

            assert_eq!(count(p, "stock_receipts").await, 0);
            assert_eq!(count(p, "stock_receipt_items").await, 0);
            assert_eq!(stock(p, a).await, 10.0);
            assert_eq!(stock(p, b).await, 10.0);
        });
    }

    #[test]
    fn backdated_receipt_keeps_chosen_day() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let a = product(p, "Choy", 10_000, 0.0).await;
            let mut r = receipt(vec![line(a, 1.0, 1.0, None)]);
            r.received_at = Some("2026-01-15T12:00:00.000Z".into());
            let out = create_receipt_tx(p, &r).await.unwrap();
            assert_eq!(out.received_at, "2026-01-15T12:00:00.000Z");
        });
    }

    #[test]
    fn void_restores_stock_cost_and_price() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let a = product(p, "Choy", 10_000, 10.0).await;
            // Xato: 7 000 o'rniga 70 000 yozilgan.
            let r = create_receipt_tx(p, &receipt(vec![line(a, 10.0, 70_000.0, Some(90_000.0))])).await.unwrap();
            assert_eq!(cost(p, a).await, 37_500.0);

            let v = void_receipt_tx(p, r.id, Some("xato narx")).await.unwrap();
            assert_eq!(v.receipt_number, r.receipt_number);
            assert_eq!(stock(p, a).await, 10.0);
            assert_eq!(cost(p, a).await, 5_000.0);
            assert_eq!(price(p, a).await, 10_000.0);

            assert_eq!(code(void_receipt_tx(p, r.id, None).await), "alreadyVoided");
            assert_eq!(code(void_receipt_tx(p, 9_999, None).await), "receiptNotFound");
        });
    }

    #[test]
    fn void_keeps_cost_changed_after_the_receipt() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let a = product(p, "Choy", 10_000, 10.0).await;
            let first = create_receipt_tx(p, &receipt(vec![line(a, 10.0, 7_000.0, None)])).await.unwrap();
            create_receipt_tx(p, &receipt(vec![line(a, 20.0, 9_000.0, None)])).await.unwrap();
            let after_second = cost(p, a).await;

            void_receipt_tx(p, first.id, None).await.unwrap();
            assert_eq!(stock(p, a).await, 30.0);
            // Keyinroq kirim bor — tannarx bosilmaydi.
            assert_eq!(cost(p, a).await, after_second);

            // Qo'lda o'zgartirilgan narx ham bosilmaydi.
            let b = product(p, "Shakar", 4_000, 0.0).await;
            let r = create_receipt_tx(p, &receipt(vec![line(b, 5.0, 3_000.0, Some(5_000.0))])).await.unwrap();
            exec(p, &format!("UPDATE products SET price = 5500 WHERE id = {b}")).await;
            void_receipt_tx(p, r.id, None).await.unwrap();
            assert_eq!(price(p, b).await, 5_500.0);
        });
    }

    #[test]
    fn void_is_refused_when_goods_already_sold_unless_negative_allowed() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 10_000, 0.0).await;
            let r = create_receipt_tx(p, &receipt(vec![line(a, 10.0, 7_000.0, None)])).await.unwrap();
            sale(p, shift, c, &[(a, 10_000, 4.0)], 0, 40_000).await;

            let e = void_receipt_tx(p, r.id, None).await.expect_err("rad etilishi kerak");
            assert_eq!(e.code, "stockWouldGoNegative");
            assert_eq!(e.params["stock"], json!(6.0));
            assert_eq!(stock(p, a).await, 6.0);
            let voided: Option<String> = sqlx::query_scalar("SELECT voided_at FROM stock_receipts").fetch_one(p).await.unwrap();
            assert!(voided.is_none());

            exec(p, "INSERT INTO settings(key, value) VALUES('allow_negative_stock', '1')").await;
            void_receipt_tx(p, r.id, None).await.unwrap();
            assert_eq!(stock(p, a).await, -4.0);
        });
    }

    #[test]
    fn concurrent_voids_succeed_only_once() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = db.pool.clone();
            let a = product(&p, "Choy", 10_000, 0.0).await;
            let r = create_receipt_tx(&p, &receipt(vec![line(a, 10.0, 7_000.0, None)])).await.unwrap();

            // Ikkita alohida task — multi-thread runtime'da haqiqatan parallel.
            let spawn = || {
                let pool = p.clone();
                tokio::spawn(async move { void_receipt_tx(&pool, r.id, None).await })
            };
            let (x, y) = (spawn(), spawn());
            let results = [x.await.unwrap(), y.await.unwrap()];
            assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
            assert!(results.iter().any(|r| r.as_ref().is_err_and(|e| e.code == "alreadyVoided")));
            assert_eq!(stock(&p, a).await, 0.0);
        });
    }

    #[test]
    fn adjustment_records_delta_and_skips_no_change() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let a = product(p, "Choy", 10_000, 10.0).await;

            let out = adjust_tx(p, a, 7.5, "manual", Some(" sanaldi ")).await.unwrap();
            assert!(out.recorded);
            assert_eq!((out.qty_before, out.qty_after, out.delta), (10.0, 7.5, -2.5));
            assert_eq!(stock(p, a).await, 7.5);
            let (delta, kind, note): (f64, String, String) =
                sqlx::query_as("SELECT delta, kind, note FROM stock_adjustments").fetch_one(p).await.unwrap();
            assert_eq!((delta, kind.as_str(), note.as_str()), (-2.5, "manual", "sanaldi"));

            let same = adjust_tx(p, a, 7.5, "manual", None).await.unwrap();
            assert!(!same.recorded);
            assert_eq!(count(p, "stock_adjustments").await, 1);

            assert_eq!(code(adjust_tx(p, a, -1.0, "manual", None).await), "invalidStock");
            assert_eq!(code(adjust_tx(p, a, f64::NAN, "manual", None).await), "invalidStock");
            assert_eq!(code(adjust_tx(p, a, 1.0, "drop table", None).await), "invalidKind");
            assert_eq!(code(adjust_tx(p, 9_999, 1.0, "manual", None).await), "productNotFound");
            assert_eq!(stock(p, a).await, 7.5);
        });
    }

    #[test]
    fn schema_is_idempotent_and_self_heals_without_migration() {
        rt().block_on(async {
            let db = migrated_db().await;
            sqlx::raw_sql(STOCK_SCHEMA_SQL).execute(&db.pool).await.unwrap();
            sqlx::raw_sql("DROP TABLE stock_receipt_items; DROP TABLE stock_receipts; DROP TABLE stock_adjustments;")
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::raw_sql(STOCK_SCHEMA_SQL).execute(&db.pool).await.unwrap();
            assert_eq!(count(&db.pool, "stock_receipts").await, 0);
        });
    }

    #[test]
    fn weighted_cost_rules() {
        assert_eq!(weighted_cost(10.0, 5_000.0, 10.0, 7_000), 6_000);
        assert_eq!(weighted_cost(0.0, 5_000.0, 10.0, 7_000), 7_000);
        assert_eq!(weighted_cost(10.0, 0.0, 10.0, 7_000), 7_000);
        assert_eq!(weighted_cost(10.0, 5_000.0, 10.0, 0), 5_000);
        // Eski kasrli tannarx: (3 × 12 527.2 + 1 × 13 000) / 4 = 12 645.4 → 12 645
        assert_eq!(weighted_cost(3.0, 12_527.2, 1.0, 13_000), 12_645);
    }
}
