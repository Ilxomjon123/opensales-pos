//! Sotuvni qaytarish (vozvrat).
//!
//! Nega Rust'da: tauri-plugin-sql pool'ida har `execute` alohida ulanish oladi, shuning
//! uchun JS'dan BEGIN/COMMIT ishlamaydi (db.ts createSale izohi). Vozvrat bir vaqtda
//! qoldiq, pul va mijoz balansini o'zgartiradi — yarmida uzilsa hisob buziladi. Bu yerda
//! hammasi bitta `BEGIN IMMEDIATE` tranzaksiyada: parallel ikkinchi so'rov birinchisini
//! kutadi va yangilangan qoldiqni ko'radi (bitta tovarni ikki marta qaytarib bo'lmaydi).
//!
//! Summa: sotuv chegirmasi qatorlarga proporsional taqsimlanadi va JAMLANIB hisoblanadi —
//! bir chek bo'yicha barcha vozvratlar yig'indisi aynan `sales.total` ga teng chiqadi.
//!
//! Pul: naqd/karta bilan qaytariladigan summa shu chek uchun haqiqatda olingan puldan
//! oshmaydi; yagona istisno — hammasi balansga yozilganda ham mijoz qarzdor bo'lib
//! qolmasa (u qarzini keyin to'lagan bo'lsa). Qolgani mijoz balansiga yoziladi.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection, SqlitePool};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

pub(crate) mod customer;

/// JS `Database.load('sqlite:pos.db')` pool'ni aynan shu kalit bilan ro'yxatga oladi.
pub const DB_URL: &str = "sqlite:pos.db";

/// Miqdor 3 xona aniqlikda (gramm) qabul qilinadi.
const QTY_SCALE: f64 = 1000.0;
/// Shu oraliqdagi miqdor "qolganining hammasi" deb olinadi (normallashtirish yarim birligi).
const QTY_SNAP: f64 = 0.5 / QTY_SCALE;
/// Suzuvchi nuqta qoldig'i (0.1 + 0.2) uchun "qolmadi" chegarasi.
const QTY_EPS: f64 = 1e-6;
const REASON_MAX_CHARS: usize = 500;

/// Vozvrat jadvallari. Migratsiya v10 VA `ensure_returns_schema` ikkalasi shu bitta
/// matnni ishlatadi: eski bazalarda migratsiyalar v8 da tiqilib qolgan (healSchema
/// `barcode_type` ni oldinroq qo'shib qo'ygani uchun v8 ALTER yiqiladi), u yerda v10
/// hech qachon qo'llanmaydi — jadvalni self-heal yaratadi. Hammasi idempotent.
pub const RETURNS_SCHEMA_SQL: &str = r#"
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
CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_shift ON sale_returns(shift_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_customer ON sale_returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_created ON sale_returns(created_at);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_return ON sale_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_sale_item ON sale_return_items(sale_item_id);
"#;

/// UI'ga boradigan xato: `code` → i18n kaliti (`returns.errors.<code>`), `params` → o'rinbosarlar.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReturnError {
    pub code: &'static str,
    pub params: Value,
}

impl ReturnError {
    fn new(code: &'static str) -> Self {
        Self { code, params: json!({}) }
    }

    fn with(code: &'static str, params: Value) -> Self {
        Self { code, params }
    }
}

impl From<sqlx::Error> for ReturnError {
    fn from(e: sqlx::Error) -> Self {
        log::error!("vozvrat: db xato: {e}");
        Self::with("db", json!({ "detail": e.to_string() }))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnLineInput {
    pub sale_item_id: i64,
    pub qty: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnRequest {
    pub sale_id: i64,
    pub lines: Vec<ReturnLineInput>,
    pub refund_cash: i64,
    pub refund_card: i64,
    pub refund_balance: i64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteLine {
    pub sale_item_id: i64,
    pub product_id: Option<i64>,
    pub product_name: String,
    pub unit: String,
    pub price: f64,
    pub qty_sold: f64,
    pub qty_returned: f64,
    pub qty_remaining: f64,
    /// So'ralgan (normallashtirilgan) miqdor; tanlanmagan qatorda 0.
    pub qty: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnQuote {
    pub sale_id: i64,
    pub receipt_number: String,
    pub sale_total: i64,
    pub already_refunded: i64,
    pub customer_id: Option<i64>,
    /// Balansga qaytarish mumkinmi — faqat nomli mijozda (yo'l-yo'lakay xaridorda yo'q).
    pub balance_allowed: bool,
    pub customer_balance: i64,
    pub lines: Vec<QuoteLine>,
    pub amount: i64,
    /// Naqd + karta orqali qaytarish mumkin bo'lgan eng ko'p summa.
    pub money_cap: i64,
    /// Taklif: shuncha qismi balansga (avval shu chekning to'lanmagan qarzi yopiladi).
    pub suggested_balance: i64,
    pub shift_open: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedReturnItem {
    pub sale_item_id: i64,
    pub product_name: String,
    pub qty: f64,
    pub unit: String,
    pub price: f64,
    pub subtotal: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedReturn {
    pub id: i64,
    pub return_number: String,
    pub sale_id: i64,
    pub receipt_number: String,
    pub amount: i64,
    pub refund_cash: i64,
    pub refund_card: i64,
    pub refund_balance: i64,
    pub reason: Option<String>,
    pub created_at: String,
    pub items: Vec<CreatedReturnItem>,
}

struct SaleRow {
    id: i64,
    receipt_number: String,
    customer_id: Option<i64>,
    total: i64,
    paid_amount: i64,
    debt_amount: i64,
}

struct ItemRow {
    id: i64,
    product_id: Option<i64>,
    product_name: String,
    // Narx/tannarx asl qiymatida (eski yozuvlarda kasr bor: 12527.2) — foyda teskarisi aynan
    // sotuvdagidek chiqishi uchun yaxlitlanmaydi.
    price: f64,
    cost_price: f64,
    qty: f64,
    unit: String,
    subtotal: i64,
    returned: f64,
}

impl ItemRow {
    fn remaining(&self) -> f64 {
        (self.qty - self.returned).max(0.0)
    }
}

#[derive(Default)]
struct Prior {
    count: i64,
    amount: i64,
    money: i64,
    balance: i64,
}

struct Computed {
    sale: SaleRow,
    items: Vec<ItemRow>,
    /// `items` bilan bir xil tartibda: so'ralgan miqdor (0 = tanlanmagan).
    requested: Vec<f64>,
    balance_allowed: bool,
    customer_balance: i64,
    prior: Prior,
    amount: i64,
    money_cap: i64,
    suggested_balance: i64,
}

fn normalize_qty(q: f64) -> f64 {
    (q * QTY_SCALE).round() / QTY_SCALE
}

/// Qatorning `cum` miqdoriga to'g'ri keladigan chegirmasiz summasi. Qator to'liq
/// qaytsa aynan `subtotal` — sotuvdagi yaxlitlash bilan bir xil bo'lishi uchun.
fn line_gross(item: &ItemRow, cum: f64) -> i64 {
    if cum <= QTY_EPS {
        return 0;
    }
    if cum >= item.qty - QTY_EPS {
        return item.subtotal;
    }
    let g = (cum * item.price).round() as i64;
    g.clamp(0, item.subtotal.max(0))
}

/// `total` ning `part / whole` ulushi, butun so'mda (yarmi yuqoriga). `part == whole`
/// bo'lsa aynan `total` — oxirgi vozvrat qoldiqni to'liq yopadi.
fn allocate(total: i64, part: i64, whole: i64) -> i64 {
    if whole <= 0 || part <= 0 {
        return 0;
    }
    if part >= whole {
        return total;
    }
    let (t, p, w) = (i128::from(total), i128::from(part), i128::from(whole));
    ((t * p * 2 + w) / (2 * w)) as i64
}

// Pul ustunlari INTEGER, lekin eski yozuvda REAL bo'lib qolgan bo'lishi mumkin
// (JS'dan kasr kelgan) — sqlx turini qat'iy tekshiradi, shuning uchun SQL'da CAST.
async fn load_sale(conn: &mut SqliteConnection, sale_id: i64) -> Result<SaleRow, ReturnError> {
    let row = sqlx::query(
        "SELECT id, receipt_number, customer_id,
                CAST(ROUND(total) AS INTEGER) total,
                CAST(ROUND(paid_amount) AS INTEGER) paid_amount,
                CAST(ROUND(debt_amount) AS INTEGER) debt_amount
         FROM sales WHERE id = ?",
    )
    .bind(sale_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| ReturnError::with("saleNotFound", json!({ "saleId": sale_id })))?;
    Ok(SaleRow {
        id: row.try_get("id")?,
        receipt_number: row.try_get("receipt_number")?,
        customer_id: row.try_get("customer_id")?,
        total: row.try_get::<i64, _>("total")?.max(0),
        paid_amount: row.try_get::<i64, _>("paid_amount")?.max(0),
        debt_amount: row.try_get::<i64, _>("debt_amount")?.max(0),
    })
}

async fn load_items(conn: &mut SqliteConnection, sale_id: i64) -> Result<Vec<ItemRow>, ReturnError> {
    let rows = sqlx::query(
        "SELECT si.id, si.product_id, si.product_name, si.unit,
                CAST(si.price AS REAL) price,
                CAST(si.cost_price AS REAL) cost_price,
                CAST(si.qty AS REAL) qty,
                CAST(ROUND(si.subtotal) AS INTEGER) subtotal,
                CAST(COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri
                               WHERE ri.sale_item_id = si.id), 0) AS REAL) returned
         FROM sale_items si WHERE si.sale_id = ? ORDER BY si.id",
    )
    .bind(sale_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(ItemRow {
                id: r.try_get("id")?,
                product_id: r.try_get("product_id")?,
                product_name: r.try_get("product_name")?,
                price: r.try_get("price")?,
                cost_price: r.try_get("cost_price")?,
                qty: r.try_get("qty")?,
                unit: r.try_get("unit")?,
                subtotal: r.try_get("subtotal")?,
                returned: r.try_get("returned")?,
            })
        })
        .collect()
}

async fn load_prior(conn: &mut SqliteConnection, sale_id: i64) -> Result<Prior, ReturnError> {
    let r = sqlx::query(
        "SELECT COUNT(*) c,
                CAST(COALESCE(SUM(amount), 0) AS INTEGER) amount,
                CAST(COALESCE(SUM(refund_cash + refund_card), 0) AS INTEGER) money,
                CAST(COALESCE(SUM(refund_balance), 0) AS INTEGER) balance
         FROM sale_returns WHERE sale_id = ?",
    )
    .bind(sale_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Prior {
        count: r.try_get("c")?,
        amount: r.try_get("amount")?,
        money: r.try_get("money")?,
        balance: r.try_get("balance")?,
    })
}

/// (yo'l-yo'lakaymi, joriy balans). Mijoz o'chirilgan bo'lsa None.
async fn load_customer(conn: &mut SqliteConnection, id: i64) -> Result<Option<(bool, i64)>, ReturnError> {
    let row = sqlx::query(
        "SELECT CAST(is_walk_in AS INTEGER) walk_in, CAST(ROUND(balance) AS INTEGER) balance
         FROM customers WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(r) => Ok(Some((r.try_get::<i64, _>("walk_in")? != 0, r.try_get("balance")?))),
        None => Ok(None),
    }
}

async fn open_shift_id(conn: &mut SqliteConnection) -> Result<Option<i64>, ReturnError> {
    let id = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await?;
    Ok(id)
}

/// So'rovni tekshiradi va summani hisoblaydi. Hech narsa yozmaydi — quote ham, create ham
/// shuni ishlatadi, shuning uchun UI ko'rgan summa bilan yoziladigan summa bir xil.
async fn compute(
    conn: &mut SqliteConnection,
    sale_id: i64,
    lines: &[ReturnLineInput],
) -> Result<Computed, ReturnError> {
    let sale = load_sale(conn, sale_id).await?;
    let items = load_items(conn, sale_id).await?;

    let mut requested = vec![0.0; items.len()];
    let mut seen = HashSet::new();
    for l in lines {
        let idx = items
            .iter()
            .position(|i| i.id == l.sale_item_id)
            .ok_or_else(|| ReturnError::with("lineNotInSale", json!({ "saleItemId": l.sale_item_id })))?;
        let item = &items[idx];
        let name = json!({ "name": item.product_name });
        if !seen.insert(l.sale_item_id) {
            return Err(ReturnError::with("duplicateLine", name));
        }
        if !l.qty.is_finite() || l.qty <= 0.0 {
            return Err(ReturnError::with("invalidQty", name));
        }
        let q = normalize_qty(l.qty);
        if q <= 0.0 {
            return Err(ReturnError::with("invalidQty", name));
        }
        let remaining = item.remaining();
        if remaining <= QTY_EPS {
            return Err(ReturnError::with("alreadyReturned", name));
        }
        if q > remaining + QTY_SNAP {
            return Err(ReturnError::with(
                "qtyExceeds",
                json!({ "name": item.product_name, "max": normalize_qty(remaining), "unit": item.unit }),
            ));
        }
        requested[idx] = if q >= remaining - QTY_SNAP { remaining } else { q };
    }

    let prior = load_prior(conn, sale_id).await?;
    let gross_total: i64 = items.iter().map(|i| i.subtotal.max(0)).sum();
    let gross_after: i64 = items
        .iter()
        .zip(&requested)
        .map(|(i, q)| line_gross(i, i.returned + q))
        .sum();
    let any = requested.iter().any(|q| *q > 0.0);
    // Jamlangan hisob: shu vozvratdan keyin qaytgan ulush − oldin qaytarilgan pul.
    let amount = if any {
        (allocate(sale.total, gross_after, gross_total) - prior.amount).max(0)
    } else {
        0
    };

    let customer = match sale.customer_id {
        Some(id) => load_customer(conn, id).await?,
        None => None,
    };
    let (balance_allowed, customer_balance) = match customer {
        Some((false, bal)) => (true, bal),
        Some((true, bal)) => (false, bal),
        None => (false, 0),
    };

    let (money_cap, suggested_balance) = if balance_allowed {
        // Chek uchun olingan pul (qaytim hisobga kirmaydi) − oldin pul bilan qaytarilgani.
        let sale_cap = (sale.paid_amount.min(sale.total) - prior.money).max(0);
        // Hammasi balansga yozilsa ham mijoz qarzdor bo'lmasa — ortig'ini naqd berish mumkin.
        let cap = sale_cap
            .max(customer_balance.saturating_add(amount))
            .clamp(0, amount);
        let outstanding = (sale.debt_amount - prior.balance).max(0);
        let owed = (-customer_balance).max(0);
        let suggested = amount.min(outstanding).min(owed).max(amount - cap);
        (cap, suggested)
    } else {
        // Yo'l-yo'lakay sotuv doim to'liq to'lanadi (createSale qarzga ruxsat bermaydi).
        (amount, 0)
    };

    Ok(Computed {
        sale,
        items,
        requested,
        balance_allowed,
        customer_balance,
        prior,
        amount,
        money_cap,
        suggested_balance,
    })
}

pub(crate) async fn quote_on(
    conn: &mut SqliteConnection,
    sale_id: i64,
    lines: &[ReturnLineInput],
) -> Result<ReturnQuote, ReturnError> {
    let c = compute(conn, sale_id, lines).await?;
    let shift_open = open_shift_id(conn).await?.is_some();
    Ok(ReturnQuote {
        sale_id: c.sale.id,
        receipt_number: c.sale.receipt_number,
        sale_total: c.sale.total,
        already_refunded: c.prior.amount,
        customer_id: c.sale.customer_id,
        balance_allowed: c.balance_allowed,
        customer_balance: c.customer_balance,
        lines: c
            .items
            .iter()
            .zip(&c.requested)
            .map(|(i, q)| QuoteLine {
                sale_item_id: i.id,
                product_id: i.product_id,
                product_name: i.product_name.clone(),
                unit: i.unit.clone(),
                price: i.price,
                qty_sold: i.qty,
                qty_returned: i.returned,
                qty_remaining: i.remaining(),
                qty: *q,
            })
            .collect(),
        amount: c.amount,
        money_cap: c.money_cap,
        suggested_balance: c.suggested_balance,
        shift_open,
    })
}

/// Tekshiradi va yozadi. Chaqiruvchi tranzaksiya ichida chaqirishi SHART.
pub(crate) async fn create_on(
    conn: &mut SqliteConnection,
    req: &ReturnRequest,
) -> Result<CreatedReturn, ReturnError> {
    let c = compute(conn, req.sale_id, &req.lines).await?;
    if !c.requested.iter().any(|q| *q > 0.0) {
        return Err(ReturnError::new("noLines"));
    }
    let reason = req
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if reason.as_ref().is_some_and(|r| r.chars().count() > REASON_MAX_CHARS) {
        return Err(ReturnError::with("reasonTooLong", json!({ "max": REASON_MAX_CHARS })));
    }
    let shift_id = open_shift_id(conn).await?.ok_or_else(|| ReturnError::new("noShift"))?;

    if req.refund_cash < 0 || req.refund_card < 0 || req.refund_balance < 0 {
        return Err(ReturnError::new("refundNegative"));
    }
    let sum = req
        .refund_cash
        .checked_add(req.refund_card)
        .and_then(|s| s.checked_add(req.refund_balance));
    if sum != Some(c.amount) {
        return Err(ReturnError::with("refundMismatch", json!({ "amount": c.amount })));
    }
    if req.refund_balance > 0 && !c.balance_allowed {
        return Err(ReturnError::new("walkInBalance"));
    }
    if req.refund_cash + req.refund_card > c.money_cap {
        return Err(ReturnError::with("cashExceedsCap", json!({ "max": c.money_cap })));
    }

    let return_number = format!("{}-V{}", c.sale.receipt_number, c.prior.count + 1);
    let return_id = sqlx::query(
        "INSERT INTO sale_returns(sale_id, shift_id, customer_id, return_number, amount,
                                  refund_cash, refund_card, refund_balance, reason, created_at)
         VALUES(?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(c.sale.id)
    .bind(shift_id)
    .bind(c.sale.customer_id)
    .bind(&return_number)
    .bind(c.amount)
    .bind(req.refund_cash)
    .bind(req.refund_card)
    .bind(req.refund_balance)
    .bind(&reason)
    .execute(&mut *conn)
    .await?
    .last_insert_rowid();

    let mut items = Vec::new();
    for (item, &q) in c.items.iter().zip(&c.requested) {
        if q <= 0.0 {
            continue;
        }
        let subtotal = line_gross(item, item.returned + q) - line_gross(item, item.returned);
        sqlx::query(
            "INSERT INTO sale_return_items(return_id, sale_item_id, product_id, product_name,
                                           price, cost_price, qty, unit, subtotal)
             VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(return_id)
        .bind(item.id)
        .bind(item.product_id)
        .bind(&item.product_name)
        .bind(item.price)
        .bind(item.cost_price)
        .bind(q)
        .bind(&item.unit)
        .bind(subtotal)
        .execute(&mut *conn)
        .await?;
        if let Some(pid) = item.product_id {
            sqlx::query("UPDATE products SET stock = stock + ? WHERE id = ?")
                .bind(q)
                .bind(pid)
                .execute(&mut *conn)
                .await?;
        }
        items.push(CreatedReturnItem {
            sale_item_id: item.id,
            product_name: item.product_name.clone(),
            qty: q,
            unit: item.unit.clone(),
            price: item.price,
            subtotal,
        });
    }

    if req.refund_balance > 0 {
        if let Some(cid) = c.sale.customer_id {
            sqlx::query("UPDATE customers SET balance = balance + ? WHERE id = ?")
                .bind(req.refund_balance)
                .bind(cid)
                .execute(&mut *conn)
                .await?;
        }
    }

    let created_at: String = sqlx::query_scalar("SELECT created_at FROM sale_returns WHERE id = ?")
        .bind(return_id)
        .fetch_one(&mut *conn)
        .await?;

    Ok(CreatedReturn {
        id: return_id,
        return_number,
        sale_id: c.sale.id,
        receipt_number: c.sale.receipt_number,
        amount: c.amount,
        refund_cash: req.refund_cash,
        refund_card: req.refund_card,
        refund_balance: req.refund_balance,
        reason,
        created_at,
        items,
    })
}

/// `BEGIN IMMEDIATE`: yozish qulfi darhol olinadi — parallel ikkinchi vozvrat shu yerda
/// kutadi (busy_timeout) va birinchisi yozgan qoldiqni ko'radi. Xatoda tranzaksiya drop
/// bo'ladi → rollback, hech narsa yarim yozilmaydi.
pub async fn create_return_tx(
    pool: &SqlitePool,
    req: &ReturnRequest,
) -> Result<CreatedReturn, ReturnError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let out = create_on(&mut tx, req).await?;
    tx.commit().await?;
    log::info!(
        "vozvrat {} · sotuv #{} · {} (naqd {}, karta {}, balans {})",
        out.return_number,
        out.sale_id,
        out.amount,
        out.refund_cash,
        out.refund_card,
        out.refund_balance
    );
    Ok(out)
}

async fn sqlite_pool(instances: &DbInstances) -> Result<SqlitePool, ReturnError> {
    let map = instances.0.read().await;
    match map.get(DB_URL) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err(ReturnError::new("dbNotLoaded")),
    }
}

#[tauri::command]
pub async fn ensure_returns_schema(instances: State<'_, DbInstances>) -> Result<(), ReturnError> {
    let pool = sqlite_pool(&instances).await?;
    sqlx::raw_sql(RETURNS_SCHEMA_SQL).execute(&pool).await?;
    Ok(())
}

#[tauri::command]
pub async fn return_quote(
    instances: State<'_, DbInstances>,
    sale_id: i64,
    lines: Vec<ReturnLineInput>,
) -> Result<ReturnQuote, ReturnError> {
    let pool = sqlite_pool(&instances).await?;
    let mut conn = pool.acquire().await?;
    quote_on(&mut conn, sale_id, &lines).await
}

#[tauri::command]
pub async fn create_return(
    instances: State<'_, DbInstances>,
    request: ReturnRequest,
) -> Result<CreatedReturn, ReturnError> {
    let pool = sqlite_pool(&instances).await?;
    create_return_tx(&pool, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::path::PathBuf;

    pub(super) fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
    }

    /// Haqiqiy fayl baza (parallel ulanishlar va qulflar prod'dagidek ishlashi uchun).
    pub(super) struct TestDb {
        pub(super) pool: SqlitePool,
        path: PathBuf,
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            for suffix in ["", "-journal", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.path.display()));
            }
        }
    }

    pub(super) async fn empty_db() -> TestDb {
        let path = std::env::temp_dir().join(format!("pos-returns-{}.db", uuid::Uuid::new_v4()));
        let opts = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await
            .expect("test db");
        TestDb { pool, path }
    }

    /// Prod'dagi barcha migratsiyalar (v10 vozvrat jadvallari ham) qo'llangan baza.
    pub(super) async fn migrated_db() -> TestDb {
        let db = empty_db().await;
        for m in crate::migrations() {
            sqlx::raw_sql(m.sql)
                .execute(&db.pool)
                .await
                .unwrap_or_else(|e| panic!("migratsiya v{}: {e}", m.version));
        }
        db
    }

    pub(super) async fn exec(pool: &SqlitePool, sql: &str) -> i64 {
        sqlx::query(sql).execute(pool).await.expect(sql).last_insert_rowid()
    }

    pub(super) async fn open_shift(pool: &SqlitePool) -> i64 {
        exec(pool, "INSERT INTO shifts(opened_at, opening_cash, status) VALUES('2026-01-01T08:00:00Z', 0, 'open')").await
    }

    pub(super) async fn walk_in(pool: &SqlitePool) -> i64 {
        exec(pool, "INSERT INTO customers(name, is_walk_in) VALUES('Yo''l-yo''lakay', 1)").await
    }

    pub(super) async fn customer(pool: &SqlitePool) -> i64 {
        exec(pool, "INSERT INTO customers(name, is_walk_in) VALUES('Ali', 0)").await
    }

    pub(super) async fn product(pool: &SqlitePool, name: &str, price: i64, stock: f64) -> i64 {
        sqlx::query("INSERT INTO products(name, price, cost_price, stock) VALUES(?, ?, ?, ?)")
            .bind(name)
            .bind(price)
            .bind(price / 2)
            .bind(stock)
            .execute(pool)
            .await
            .unwrap()
            .last_insert_rowid()
    }

    /// db.ts createSale bilan bir xil yozuv: qoldiq kamayadi, qarz balansdan ayiriladi.
    pub(super) async fn sale(
        pool: &SqlitePool,
        shift: i64,
        cust: i64,
        lines: &[(i64, i64, f64)],
        discount: i64,
        paid: i64,
    ) -> (i64, Vec<i64>) {
        let subtotal: i64 = lines.iter().map(|(_, p, q)| (*p as f64 * q).round() as i64).sum();
        let total = (subtotal - discount).max(0);
        let debt = (total - paid).max(0);
        let status = if debt == 0 { "paid" } else if paid == 0 { "debt" } else { "partial" };
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) + 1 FROM sales").fetch_one(pool).await.unwrap();
        let sale_id = sqlx::query(
            "INSERT INTO sales(receipt_number, shift_id, customer_id, total, discount, paid_cash, paid_card,
                               paid_amount, debt_amount, payment_status, created_at)
             VALUES(?,?,?,?,?,?,0,?,?,?, '2026-01-01T09:00:00Z')",
        )
        .bind(format!("{shift}-{n:05}"))
        .bind(shift)
        .bind(cust)
        .bind(total)
        .bind(discount)
        .bind(paid)
        .bind(paid)
        .bind(debt)
        .bind(status)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid();
        let mut item_ids = Vec::new();
        for (pid, price, qty) in lines {
            let name: String = sqlx::query_scalar("SELECT name FROM products WHERE id = ?")
                .bind(pid)
                .fetch_one(pool)
                .await
                .unwrap();
            let id = sqlx::query(
                "INSERT INTO sale_items(sale_id, product_id, product_name, price, cost_price, qty, unit, subtotal)
                 VALUES(?,?,?,?,?,?, 'dona', ?)",
            )
            .bind(sale_id)
            .bind(pid)
            .bind(name)
            .bind(price)
            .bind(price / 2)
            .bind(qty)
            .bind((*price as f64 * qty).round() as i64)
            .execute(pool)
            .await
            .unwrap()
            .last_insert_rowid();
            sqlx::query("UPDATE products SET stock = stock - ? WHERE id = ?")
                .bind(qty)
                .bind(pid)
                .execute(pool)
                .await
                .unwrap();
            item_ids.push(id);
        }
        sqlx::query(
            "UPDATE customers SET balance = balance - ? WHERE id = ? AND is_walk_in = 0",
        )
        .bind(debt)
        .bind(cust)
        .execute(pool)
        .await
        .unwrap();
        (sale_id, item_ids)
    }

    pub(super) fn lines(items: &[(i64, f64)]) -> Vec<ReturnLineInput> {
        items
            .iter()
            .map(|(id, qty)| ReturnLineInput { sale_item_id: *id, qty: *qty })
            .collect()
    }

    pub(super) fn req(sale_id: i64, items: &[(i64, f64)], cash: i64, card: i64, balance: i64) -> ReturnRequest {
        ReturnRequest {
            sale_id,
            lines: lines(items),
            refund_cash: cash,
            refund_card: card,
            refund_balance: balance,
            reason: None,
        }
    }

    async fn quote(pool: &SqlitePool, sale_id: i64, items: &[(i64, f64)]) -> Result<ReturnQuote, ReturnError> {
        let mut conn = pool.acquire().await.unwrap();
        quote_on(&mut conn, sale_id, &lines(items)).await
    }

    pub(super) async fn stock(pool: &SqlitePool, pid: i64) -> f64 {
        sqlx::query_scalar("SELECT stock FROM products WHERE id = ?").bind(pid).fetch_one(pool).await.unwrap()
    }

    pub(super) async fn balance(pool: &SqlitePool, cid: i64) -> i64 {
        sqlx::query_scalar("SELECT balance FROM customers WHERE id = ?").bind(cid).fetch_one(pool).await.unwrap()
    }

    pub(super) async fn count(pool: &SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")).fetch_one(pool).await.unwrap()
    }

    fn code(r: Result<CreatedReturn, ReturnError>) -> &'static str {
        r.expect_err("xato kutilgan edi").code
    }

    #[test]
    fn full_return_with_discount_refunds_exact_total_and_restores_stock() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Choy", 10_000, 10.0).await;
            let b = product(p, "Shakar", 3_333, 10.0).await;
            // 20 000 + 9 999 = 29 999, chegirma 999 → 29 000
            let (s, it) = sale(p, shift, w, &[(a, 10_000, 2.0), (b, 3_333, 3.0)], 999, 29_000).await;

            let q = quote(p, s, &[(it[0], 2.0), (it[1], 3.0)]).await.unwrap();
            assert_eq!(q.amount, 29_000);
            assert_eq!(q.money_cap, 29_000);
            assert_eq!(q.suggested_balance, 0);
            assert!(!q.balance_allowed);
            assert!(q.shift_open);

            let r = create_return_tx(p, &req(s, &[(it[0], 2.0), (it[1], 3.0)], 29_000, 0, 0)).await.unwrap();
            assert_eq!(r.amount, 29_000);
            assert_eq!(r.return_number, format!("{shift}-00001-V1"));
            assert_eq!(r.items.iter().map(|i| i.subtotal).sum::<i64>(), 29_999);
            assert_eq!(stock(p, a).await, 10.0);
            assert_eq!(stock(p, b).await, 10.0);
            assert!(r.created_at.ends_with('Z') && r.created_at.contains('T'), "{}", r.created_at);
        });
    }

    #[test]
    fn partial_returns_add_up_exactly_to_sale_total() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Choy", 10_000, 10.0).await;
            let b = product(p, "Shakar", 3_333, 10.0).await;
            let (s, it) = sale(p, shift, w, &[(a, 10_000, 2.0), (b, 3_333, 3.0)], 999, 29_000).await;

            let mut refunded = 0;
            for (item, qty) in [(it[1], 1.0), (it[1], 1.0), (it[0], 1.0), (it[1], 1.0), (it[0], 1.0)] {
                let q = quote(p, s, &[(item, qty)]).await.unwrap();
                let r = create_return_tx(p, &req(s, &[(item, qty)], q.amount, 0, 0)).await.unwrap();
                assert_eq!(r.amount, q.amount, "quote va yozilgan summa bir xil bo'lishi kerak");
                refunded += r.amount;
            }
            assert_eq!(refunded, 29_000, "yaxlitlash qoldig'i qolmasligi kerak");
            assert_eq!(count(p, "sale_returns").await, 5);
            let last: String = sqlx::query_scalar("SELECT return_number FROM sale_returns ORDER BY id DESC LIMIT 1")
                .fetch_one(p)
                .await
                .unwrap();
            assert!(last.ends_with("-V5"), "{last}");
        });
    }

    #[test]
    fn over_return_and_repeat_return_are_rejected_without_writes() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Choy", 1_000, 5.0).await;
            let (s, it) = sale(p, shift, w, &[(a, 1_000, 2.0)], 0, 2_000).await;

            let e = create_return_tx(p, &req(s, &[(it[0], 3.0)], 3_000, 0, 0)).await.unwrap_err();
            assert_eq!(e.code, "qtyExceeds");
            assert_eq!(e.params["max"], json!(2.0));
            assert_eq!(count(p, "sale_returns").await, 0);
            assert_eq!(stock(p, a).await, 3.0);

            create_return_tx(p, &req(s, &[(it[0], 2.0)], 2_000, 0, 0)).await.unwrap();
            assert_eq!(code(create_return_tx(p, &req(s, &[(it[0], 1.0)], 1_000, 0, 0)).await), "alreadyReturned");
            assert_eq!(stock(p, a).await, 5.0);
        });
    }

    #[test]
    fn concurrent_double_return_succeeds_only_once() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            let (s, it) = sale(p, shift, w, &[(a, 1_000, 4.0)], 0, 4_000).await;

            // Ikkita alohida task — multi-thread runtime'da haqiqatan parallel.
            let spawn = || {
                let (pool, r) = (p.clone(), req(s, &[(it[0], 4.0)], 4_000, 0, 0));
                tokio::spawn(async move { create_return_tx(&pool, &r).await })
            };
            let (hx, hy) = (spawn(), spawn());
            let (x, y) = (hx.await.unwrap(), hy.await.unwrap());
            let oks = [x.is_ok(), y.is_ok()].iter().filter(|o| **o).count();
            assert_eq!(oks, 1, "aynan bittasi o'tishi kerak: {x:?} / {y:?}");
            let err = x.err().or(y.err()).unwrap();
            assert_eq!(err.code, "alreadyReturned");
            assert_eq!(stock(p, a).await, 0.0, "qoldiq bir marta qaytishi kerak");
            assert_eq!(count(p, "sale_returns").await, 1);
        });
    }

    #[test]
    fn failure_midway_rolls_back_everything() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            let boom = product(p, "BOOM", 1_000, 0.0).await;
            let (s, it) = sale(p, shift, c, &[(a, 1_000, 1.0), (boom, 1_000, 1.0)], 0, 0).await;
            assert_eq!(balance(p, c).await, -2_000);
            // Ikkinchi qator yozilayotganda yiqiladi — birinchisining qoldig'i allaqachon o'zgargan.
            exec(
                p,
                "CREATE TRIGGER boom BEFORE INSERT ON sale_return_items WHEN NEW.product_name = 'BOOM'
                 BEGIN SELECT RAISE(ABORT, 'boom'); END",
            )
            .await;

            let e = create_return_tx(p, &req(s, &[(it[0], 1.0), (it[1], 1.0)], 0, 0, 2_000)).await.unwrap_err();
            assert_eq!(e.code, "db");
            assert_eq!(count(p, "sale_returns").await, 0);
            assert_eq!(count(p, "sale_return_items").await, 0);
            assert_eq!(stock(p, a).await, -1.0, "birinchi qator qoldig'i ham qaytarilishi kerak");
            assert_eq!(balance(p, c).await, -2_000);
        });
    }

    #[test]
    fn walk_in_cannot_refund_to_balance() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            let (s, it) = sale(p, shift, w, &[(a, 1_000, 1.0)], 0, 1_000).await;
            assert_eq!(code(create_return_tx(p, &req(s, &[(it[0], 1.0)], 0, 0, 1_000)).await), "walkInBalance");
            // Karta orqali qaytarish mumkin.
            create_return_tx(p, &req(s, &[(it[0], 1.0)], 0, 1_000, 0)).await.unwrap();
        });
    }

    #[test]
    fn debt_sale_goes_to_balance_and_cash_is_capped() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 25_000, 0.0).await;
            let (s, it) = sale(p, shift, c, &[(a, 25_000, 2.0)], 0, 0).await;
            assert_eq!(balance(p, c).await, -50_000);

            let q = quote(p, s, &[(it[0], 2.0)]).await.unwrap();
            assert_eq!((q.amount, q.money_cap, q.suggested_balance), (50_000, 0, 50_000));

            let e = create_return_tx(p, &req(s, &[(it[0], 2.0)], 50_000, 0, 0)).await.unwrap_err();
            assert_eq!(e.code, "cashExceedsCap");
            assert_eq!(e.params["max"], json!(0));

            create_return_tx(p, &req(s, &[(it[0], 2.0)], 0, 0, 50_000)).await.unwrap();
            assert_eq!(balance(p, c).await, 0);
        });
    }

    #[test]
    fn partially_paid_sale_closes_its_debt_first() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 50_000, 0.0).await;
            let (s, it) = sale(p, shift, c, &[(a, 50_000, 2.0)], 0, 60_000).await;
            assert_eq!(balance(p, c).await, -40_000);

            // Yarmini qaytarish: 50 000 → avval 40 000 qarz yopiladi, 10 000 naqd.
            let q = quote(p, s, &[(it[0], 1.0)]).await.unwrap();
            assert_eq!((q.amount, q.money_cap, q.suggested_balance), (50_000, 50_000, 40_000));
            create_return_tx(p, &req(s, &[(it[0], 1.0)], 10_000, 0, 40_000)).await.unwrap();
            assert_eq!(balance(p, c).await, 0);

            // Qolgan yarmi: qarz yo'q, olingan puldan 50 000 qolgan — hammasi naqd.
            let q = quote(p, s, &[(it[0], 1.0)]).await.unwrap();
            assert_eq!((q.amount, q.money_cap, q.suggested_balance), (50_000, 50_000, 0));
            create_return_tx(p, &req(s, &[(it[0], 1.0)], 50_000, 0, 0)).await.unwrap();
            let refunded: i64 = sqlx::query_scalar("SELECT SUM(refund_cash) FROM sale_returns").fetch_one(p).await.unwrap();
            assert_eq!(refunded, 60_000, "naqd jami olingan puldan oshmasligi kerak");
        });
    }

    #[test]
    fn debt_paid_later_allows_full_cash_refund() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 100_000, 0.0).await;
            let (s, it) = sale(p, shift, c, &[(a, 100_000, 1.0)], 0, 60_000).await;
            // Mijoz qarzini keyin to'ladi (recordCustomerPayment).
            exec(p, &format!("UPDATE customers SET balance = balance + 40000 WHERE id = {c}")).await;

            let q = quote(p, s, &[(it[0], 1.0)]).await.unwrap();
            assert_eq!((q.amount, q.money_cap, q.suggested_balance), (100_000, 100_000, 0));
            create_return_tx(p, &req(s, &[(it[0], 1.0)], 100_000, 0, 0)).await.unwrap();
            assert_eq!(balance(p, c).await, 0);
        });
    }

    #[test]
    fn refund_split_must_match_amount() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            let (s, it) = sale(p, shift, c, &[(a, 1_000, 2.0)], 0, 2_000).await;
            let e = create_return_tx(p, &req(s, &[(it[0], 1.0)], 999, 0, 0)).await.unwrap_err();
            assert_eq!(e.code, "refundMismatch");
            assert_eq!(e.params["amount"], json!(1_000));
            assert_eq!(code(create_return_tx(p, &req(s, &[(it[0], 1.0)], 2_000, 0, -1_000)).await), "refundNegative");
            assert_eq!(code(create_return_tx(p, &req(s, &[(it[0], 1.0)], i64::MAX, 1, 0)).await), "refundMismatch");
            assert_eq!(count(p, "sale_returns").await, 0);
        });
    }

    #[test]
    fn invalid_input_is_rejected_with_specific_codes() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            let (s, it) = sale(p, shift, w, &[(a, 1_000, 2.0)], 0, 2_000).await;
            let (s2, it2) = sale(p, shift, w, &[(a, 1_000, 1.0)], 0, 1_000).await;
            let i = it[0];

            for bad in [0.0, -1.0, f64::NAN, f64::INFINITY, 0.0004] {
                let e = create_return_tx(p, &req(s, &[(i, bad)], 0, 0, 0)).await.unwrap_err();
                assert_eq!(e.code, "invalidQty", "qty={bad}");
            }
            assert_eq!(code(create_return_tx(p, &req(s, &[(it2[0], 1.0)], 1_000, 0, 0)).await), "lineNotInSale");
            assert_eq!(code(create_return_tx(p, &req(s, &[(i, 1.0), (i, 1.0)], 2_000, 0, 0)).await), "duplicateLine");
            assert_eq!(code(create_return_tx(p, &req(s, &[], 0, 0, 0)).await), "noLines");
            assert_eq!(code(create_return_tx(p, &req(999_999, &[(i, 1.0)], 1_000, 0, 0)).await), "saleNotFound");

            let mut long = req(s, &[(i, 1.0)], 1_000, 0, 0);
            long.reason = Some("x".repeat(REASON_MAX_CHARS + 1));
            assert_eq!(code(create_return_tx(p, &long).await), "reasonTooLong");
            // Bo'sh sabab NULL bo'lib saqlanadi.
            let mut blank = req(s2, &[(it2[0], 1.0)], 1_000, 0, 0);
            blank.reason = Some("   ".into());
            assert_eq!(create_return_tx(p, &blank).await.unwrap().reason, None);
            assert_eq!(count(p, "sale_returns").await, 1);
        });
    }

    #[test]
    fn return_requires_open_shift_but_quote_does_not() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            let (s, it) = sale(p, shift, w, &[(a, 1_000, 1.0)], 0, 1_000).await;
            exec(p, "UPDATE shifts SET status = 'closed'").await;

            let q = quote(p, s, &[(it[0], 1.0)]).await.unwrap();
            assert!(!q.shift_open);
            assert_eq!(q.amount, 1_000);
            assert_eq!(code(create_return_tx(p, &req(s, &[(it[0], 1.0)], 1_000, 0, 0)).await), "noShift");

            // Yangi smenada qaytarish shu smenaga yoziladi.
            let shift2 = open_shift(p).await;
            create_return_tx(p, &req(s, &[(it[0], 1.0)], 1_000, 0, 0)).await.unwrap();
            let sid: i64 = sqlx::query_scalar("SELECT shift_id FROM sale_returns").fetch_one(p).await.unwrap();
            assert_eq!(sid, shift2);
        });
    }

    #[test]
    fn fractional_quantities_snap_to_remaining() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Guruch", 12_000, 0.0).await;
            let (s, it) = sale(p, shift, w, &[(a, 12_000, 2.25)], 0, 27_000).await;

            let r = create_return_tx(p, &req(s, &[(it[0], 1.5)], 18_000, 0, 0)).await.unwrap();
            assert_eq!(r.amount, 18_000);
            let q = quote(p, s, &[]).await.unwrap();
            assert!((q.lines[0].qty_remaining - 0.75).abs() < 1e-9);
            assert_eq!(q.amount, 0);

            let e = create_return_tx(p, &req(s, &[(it[0], 0.7515)], 9_000, 0, 0)).await.unwrap_err();
            assert_eq!(e.code, "qtyExceeds");
            // Yarim birlik ichidagi miqdor "qolganining hammasi" deb olinadi.
            let r = create_return_tx(p, &req(s, &[(it[0], 0.7504)], 9_000, 0, 0)).await.unwrap();
            assert_eq!(r.amount, 9_000);
            assert!((r.items[0].qty - 0.75).abs() < 1e-9);
            assert!(stock(p, a).await.abs() < 1e-9);
        });
    }

    #[test]
    fn fully_discounted_sale_returns_goods_with_zero_refund() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Sovg'a", 5_000, 0.0).await;
            let (s, it) = sale(p, shift, w, &[(a, 5_000, 1.0)], 5_000, 0).await;
            let r = create_return_tx(p, &req(s, &[(it[0], 1.0)], 0, 0, 0)).await.unwrap();
            assert_eq!(r.amount, 0);
            assert_eq!(stock(p, a).await, 0.0);
        });
    }

    // Real bazada INTEGER ustunlarda kasr qiymatlar bor (cost_price 12527.2, JS'dan kelgan
    // paid_cash). Dekod yiqilmasligi va tannarx asl holicha ko'chishi kerak.
    #[test]
    fn legacy_fractional_values_in_integer_columns_are_handled() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let a = product(p, "Choy", 17_225, 0.0).await;
            let (s, it) = sale(p, shift, w, &[(a, 17_225, 1.0)], 0, 17_225).await;
            exec(p, &format!("UPDATE sale_items SET cost_price = 12527.2 WHERE id = {}", it[0])).await;
            exec(p, &format!("UPDATE sales SET paid_cash = 17225.4, paid_amount = 17225.4 WHERE id = {s}")).await;

            let q = quote(p, s, &[(it[0], 1.0)]).await.unwrap();
            assert_eq!(q.amount, 17_225);
            create_return_tx(p, &req(s, &[(it[0], 1.0)], 17_225, 0, 0)).await.unwrap();
            let cost: f64 = sqlx::query_scalar("SELECT cost_price FROM sale_return_items").fetch_one(p).await.unwrap();
            assert!((cost - 12527.2).abs() < 1e-9, "tannarx yaxlitlanmasligi kerak: {cost}");
        });
    }

    // Lokal bazalar migratsiya v8 da tiqilgan (v9/v10 qo'llanmaydi) — jadvalni self-heal yaratadi.
    #[test]
    fn schema_self_heal_works_on_db_stuck_before_v10() {
        rt().block_on(async {
            let db = empty_db().await;
            for m in crate::migrations().into_iter().filter(|m| m.version <= 7) {
                sqlx::raw_sql(m.sql).execute(&db.pool).await.unwrap();
            }
            sqlx::raw_sql(RETURNS_SCHEMA_SQL).execute(&db.pool).await.unwrap();
            sqlx::raw_sql(RETURNS_SCHEMA_SQL).execute(&db.pool).await.expect("idempotent bo'lishi kerak");
            assert_eq!(count(&db.pool, "sale_returns").await, 0);
            assert_eq!(count(&db.pool, "sale_return_items").await, 0);
        });
    }

    #[test]
    fn migration_v10_is_the_shared_returns_schema() {
        let v10 = crate::migrations().into_iter().find(|m| m.version == 10).expect("v10");
        assert_eq!(v10.sql, RETURNS_SCHEMA_SQL);
    }

    #[test]
    fn error_serializes_as_code_and_params() {
        let v = serde_json::to_value(ReturnError::with("qtyExceeds", json!({ "max": 2.0 }))).unwrap();
        assert_eq!(v, json!({ "code": "qtyExceeds", "params": { "max": 2.0 } }));
    }

    #[test]
    fn allocate_rounds_half_up_and_hits_total_exactly() {
        assert_eq!(allocate(29_000, 29_999, 29_999), 29_000);
        assert_eq!(allocate(29_000, 3_333, 29_999), 3_222); // 3222.07…
        assert_eq!(allocate(3, 1, 2), 2); // 1.5 → 2
        assert_eq!(allocate(100, 0, 10), 0);
        assert_eq!(allocate(100, 5, 0), 0);
        assert_eq!(allocate(i64::MAX / 2, 1, 2), i64::MAX / 4 + 1);
    }
}
