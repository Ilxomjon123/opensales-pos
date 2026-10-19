//! Mijoz bo'yicha vozvrat: kassir chek qidirmaydi — tovar va miqdorni tanlaydi, tizim
//! uni shu mijozning cheklari orasida ENG YANGISIDAN boshlab taqsimlaydi.
//!
//! Ichkarida bu baribir har chek bo'yicha alohida vozvrat (`create_on`) — summa, chegirma,
//! pul cheklovi va qoldiq qoidalari chek darajasida o'zgarishsiz qoladi. Hammasi bitta
//! `BEGIN IMMEDIATE` tranzaksiyada: biror chek yiqilsa, boshqalari ham yozilmaydi.
//!
//! Faqat nomli mijoz: yo'l-yo'lakay xaridorning sotuvlari umumiy — u yerda "mijoz bo'yicha"
//! amalda cheksiz vozvrat bo'lib qoladi, shuning uchun u chek bo'yicha qaytaradi.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Row, SqliteConnection, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;

use super::{
    compute, create_on, load_customer, normalize_qty, open_shift_id, sqlite_pool, CreatedReturn,
    ReturnError, ReturnLineInput, ReturnRequest, QTY_EPS, QTY_SNAP,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductQtyInput {
    pub product_id: i64,
    pub qty: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerReturnRequest {
    pub customer_id: i64,
    pub lines: Vec<ProductQtyInput>,
    pub refund_cash: i64,
    pub refund_card: i64,
    pub refund_balance: i64,
    pub reason: Option<String>,
}

/// Mijoz olgan va hali qaytarish mumkin bo'lgan tovar (barcha cheklari bo'yicha jami).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnableProduct {
    pub product_id: i64,
    pub product_name: String,
    pub unit: String,
    pub qty_sold: f64,
    pub qty_returned: f64,
    pub qty_remaining: f64,
    /// Eng oxirgi sotilgan narx — tanlashda ko'rsatish uchun.
    pub last_price: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationLine {
    pub sale_item_id: i64,
    pub product_name: String,
    pub unit: String,
    pub qty: f64,
    pub price: f64,
}

/// Bitta chekka tushgan qism: qaysi qatorlar, qancha summa va shu chekning pul cheklovi.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleAllocation {
    pub sale_id: i64,
    pub receipt_number: String,
    pub created_at: String,
    pub lines: Vec<AllocationLine>,
    pub amount: i64,
    pub money_cap: i64,
    pub suggested_balance: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerReturnQuote {
    pub customer_id: i64,
    pub customer_balance: i64,
    pub products: Vec<ReturnableProduct>,
    pub allocations: Vec<SaleAllocation>,
    pub amount: i64,
    /// Naqd + karta bilan jami ko'pi bilan (har chek chegarasi yig'indisi).
    pub money_cap: i64,
    /// Balansga eng kamida shuncha yozilishi shart (= amount − money_cap).
    pub balance_min: i64,
    pub suggested_balance: i64,
    pub shift_open: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerReturnResult {
    pub returns: Vec<CreatedReturn>,
    pub amount: i64,
    pub refund_cash: i64,
    pub refund_card: i64,
    pub refund_balance: i64,
}

struct CustItem {
    id: i64,
    sale_id: i64,
    created_at: String,
    product_id: i64,
    product_name: String,
    unit: String,
    price: f64,
    qty: f64,
    returned: f64,
}

impl CustItem {
    fn remaining(&self) -> f64 {
        (self.qty - self.returned).max(0.0)
    }
}

/// Bitta chekka ajratilgan so'rov qatorlari (sale_id, qatorlar), eng yangi chek birinchi.
type Plan = Vec<(i64, Vec<ReturnLineInput>)>;

/// Mijozning barcha sotuv qatorlari — eng yangi chek va qator birinchi.
async fn load_items(conn: &mut SqliteConnection, customer_id: i64) -> Result<Vec<CustItem>, ReturnError> {
    let rows = sqlx::query(
        "SELECT si.id, si.sale_id, s.created_at, si.product_id, si.product_name, si.unit,
                CAST(si.price AS REAL) price, CAST(si.qty AS REAL) qty,
                CAST(COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri
                               WHERE ri.sale_item_id = si.id), 0) AS REAL) returned
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.customer_id = ? AND si.product_id IS NOT NULL
         ORDER BY s.id DESC, si.id DESC",
    )
    .bind(customer_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(CustItem {
                id: r.try_get("id")?,
                sale_id: r.try_get("sale_id")?,
                created_at: r.try_get("created_at")?,
                product_id: r.try_get("product_id")?,
                product_name: r.try_get("product_name")?,
                unit: r.try_get("unit")?,
                price: r.try_get("price")?,
                qty: r.try_get("qty")?,
                returned: r.try_get("returned")?,
            })
        })
        .collect()
}

/// Tovarlar bo'yicha jamlanma (qatorlar tartibida — eng yangi sotilgani birinchi).
fn returnable_products(items: &[CustItem]) -> Vec<ReturnableProduct> {
    let mut out: Vec<ReturnableProduct> = Vec::new();
    for it in items {
        match out.iter_mut().find(|p| p.product_id == it.product_id) {
            Some(p) => {
                p.qty_sold += it.qty;
                p.qty_returned += it.returned;
                p.qty_remaining += it.remaining();
            }
            None => out.push(ReturnableProduct {
                product_id: it.product_id,
                product_name: it.product_name.clone(),
                unit: it.unit.clone(),
                qty_sold: it.qty,
                qty_returned: it.returned,
                qty_remaining: it.remaining(),
                last_price: it.price,
            }),
        }
    }
    out.retain(|p| p.qty_remaining > QTY_EPS);
    out
}

/// Nomli mijozni tekshiradi → joriy balans.
async fn named_customer(conn: &mut SqliteConnection, customer_id: i64) -> Result<i64, ReturnError> {
    match load_customer(conn, customer_id).await? {
        None => Err(ReturnError::with("customerNotFound", json!({ "customerId": customer_id }))),
        Some((true, _)) => Err(ReturnError::new("walkInNeedsReceipt")),
        Some((false, balance)) => Ok(balance),
    }
}

/// So'ralgan tovar miqdorlarini cheklarga taqsimlaydi: eng yangi chekdan boshlab.
fn plan(items: &[CustItem], lines: &[ProductQtyInput]) -> Result<Plan, ReturnError> {
    let mut plan: Plan = Vec::new();
    let mut seen = HashSet::new();
    for l in lines {
        let rows: Vec<&CustItem> = items.iter().filter(|i| i.product_id == l.product_id).collect();
        let Some(first) = rows.first() else {
            return Err(ReturnError::with("productNotBought", json!({ "productId": l.product_id })));
        };
        let name = json!({ "name": first.product_name });
        if !seen.insert(l.product_id) {
            return Err(ReturnError::with("duplicateLine", name));
        }
        if !l.qty.is_finite() || l.qty <= 0.0 {
            return Err(ReturnError::with("invalidQty", name));
        }
        let q = normalize_qty(l.qty);
        if q <= 0.0 {
            return Err(ReturnError::with("invalidQty", name));
        }
        let total: f64 = rows.iter().map(|i| i.remaining()).sum();
        if total <= QTY_EPS {
            return Err(ReturnError::with("alreadyReturned", name));
        }
        if q > total + QTY_SNAP {
            return Err(ReturnError::with(
                "qtyExceeds",
                json!({ "name": first.product_name, "max": normalize_qty(total), "unit": first.unit }),
            ));
        }
        let mut left = q;
        for it in rows {
            let rem = it.remaining();
            if rem <= QTY_EPS {
                continue;
            }
            // Qolgani shu qatorga sig'sa (yarim birlik aniqlikda) — hammasi shu yerga.
            let take = if left >= rem - QTY_SNAP { rem } else { left };
            let line = ReturnLineInput { sale_item_id: it.id, qty: take };
            match plan.iter_mut().find(|(sid, _)| *sid == it.sale_id) {
                Some((_, ls)) => ls.push(line),
                None => plan.push((it.sale_id, vec![line])),
            }
            left -= take;
            if left <= QTY_SNAP {
                break;
            }
        }
    }
    // Chek tartibi: eng yangisi birinchi (sale_id kamayishi).
    plan.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(plan)
}

/// Chek darajasidagi summa va cheklovlar (quote ham, create ham shuni ishlatadi).
async fn allocations(
    conn: &mut SqliteConnection,
    items: &[CustItem],
    plan: &Plan,
) -> Result<Vec<SaleAllocation>, ReturnError> {
    let mut out = Vec::with_capacity(plan.len());
    for (sale_id, lines) in plan {
        let c = compute(conn, *sale_id, lines).await?;
        let meta = items.iter().find(|i| i.sale_id == *sale_id);
        out.push(SaleAllocation {
            sale_id: *sale_id,
            receipt_number: c.sale.receipt_number.clone(),
            created_at: meta.map(|m| m.created_at.clone()).unwrap_or_default(),
            lines: c
                .items
                .iter()
                .zip(&c.requested)
                .filter(|(_, q)| **q > 0.0)
                .map(|(i, q)| AllocationLine {
                    sale_item_id: i.id,
                    product_name: i.product_name.clone(),
                    unit: i.unit.clone(),
                    qty: *q,
                    price: i.price,
                })
                .collect(),
            amount: c.amount,
            money_cap: c.money_cap,
            suggested_balance: c.suggested_balance,
        });
    }
    Ok(out)
}

/// Umumiy (naqd, karta, balans) ni cheklarga taqsimlaydi. Har chekda: balans ∈
/// [summa − pul_chegarasi, summa]. Balans avval taklif qilingan joyga (chekning
/// to'lanmagan qarzi), keyin qolganiga; karta pul qismlariga ketma-ket, qolgani naqd.
/// Natija: har chek uchun (naqd, karta, balans).
pub(crate) fn split_refunds(
    allocs: &[SaleAllocation],
    cash: i64,
    card: i64,
    balance: i64,
) -> Result<Vec<(i64, i64, i64)>, ReturnError> {
    let amount: i64 = allocs.iter().map(|a| a.amount).sum();
    if cash < 0 || card < 0 || balance < 0 {
        return Err(ReturnError::new("refundNegative"));
    }
    let sum = cash.checked_add(card).and_then(|s| s.checked_add(balance));
    if sum != Some(amount) {
        return Err(ReturnError::with("refundMismatch", json!({ "amount": amount })));
    }
    let lower: Vec<i64> = allocs.iter().map(|a| (a.amount - a.money_cap).max(0)).collect();
    let min_balance: i64 = lower.iter().sum();
    if balance < min_balance {
        return Err(ReturnError::with("cashExceedsCap", json!({ "max": amount - min_balance })));
    }
    let mut bal = lower;
    let mut left = balance - min_balance;
    for (b, a) in bal.iter_mut().zip(allocs) {
        let add = left.min((a.suggested_balance - *b).max(0));
        *b += add;
        left -= add;
    }
    for (b, a) in bal.iter_mut().zip(allocs) {
        let add = left.min(a.amount - *b);
        *b += add;
        left -= add;
    }
    debug_assert_eq!(left, 0);
    let mut card_left = card;
    Ok(bal
        .iter()
        .zip(allocs)
        .map(|(b, a)| {
            let money = a.amount - b;
            let c = card_left.min(money);
            card_left -= c;
            (money - c, c, *b)
        })
        .collect())
}

pub(crate) async fn customer_quote_on(
    conn: &mut SqliteConnection,
    customer_id: i64,
    lines: &[ProductQtyInput],
) -> Result<CustomerReturnQuote, ReturnError> {
    let customer_balance = named_customer(conn, customer_id).await?;
    let items = load_items(conn, customer_id).await?;
    let plan = plan(&items, lines)?;
    let allocs = allocations(conn, &items, &plan).await?;
    let amount: i64 = allocs.iter().map(|a| a.amount).sum();
    let money_cap: i64 = allocs.iter().map(|a| a.money_cap).sum();
    let shift_open = open_shift_id(conn).await?.is_some();
    Ok(CustomerReturnQuote {
        customer_id,
        customer_balance,
        products: returnable_products(&items),
        amount,
        money_cap,
        balance_min: amount - money_cap,
        suggested_balance: allocs.iter().map(|a| a.suggested_balance).sum(),
        allocations: allocs,
        shift_open,
    })
}

/// Tranzaksiya ichida chaqirilishi SHART.
async fn customer_create_on(
    conn: &mut SqliteConnection,
    req: &CustomerReturnRequest,
) -> Result<CustomerReturnResult, ReturnError> {
    named_customer(conn, req.customer_id).await?;
    if req.lines.is_empty() {
        return Err(ReturnError::new("noLines"));
    }
    let items = load_items(conn, req.customer_id).await?;
    let plan = plan(&items, &req.lines)?;
    let allocs = allocations(conn, &items, &plan).await?;
    let split = split_refunds(&allocs, req.refund_cash, req.refund_card, req.refund_balance)?;

    // Balansga yozish keyingi cheklarning pul chegarasini faqat oshiradi (mijoz balansi
    // ortadi), naqd esa balansga tegmaydi — shuning uchun oldindan hisoblangan taqsimot
    // har bir create_on tekshiruvidan o'tadi.
    let mut returns = Vec::with_capacity(plan.len());
    for ((sale_id, lines), (cash, card, balance)) in plan.iter().zip(split) {
        let r = create_on(
            conn,
            &ReturnRequest {
                sale_id: *sale_id,
                lines: lines.clone(),
                refund_cash: cash,
                refund_card: card,
                refund_balance: balance,
                reason: req.reason.clone(),
            },
        )
        .await?;
        returns.push(r);
    }
    Ok(CustomerReturnResult {
        amount: returns.iter().map(|r| r.amount).sum(),
        refund_cash: req.refund_cash,
        refund_card: req.refund_card,
        refund_balance: req.refund_balance,
        returns,
    })
}

pub async fn create_customer_return_tx(
    pool: &SqlitePool,
    req: &CustomerReturnRequest,
) -> Result<CustomerReturnResult, ReturnError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let out = customer_create_on(&mut tx, req).await?;
    tx.commit().await?;
    log::info!(
        "mijoz vozvrati · mijoz #{} · {} chek · {}",
        req.customer_id,
        out.returns.len(),
        out.amount
    );
    Ok(out)
}

#[tauri::command]
pub async fn customer_return_quote(
    instances: State<'_, DbInstances>,
    customer_id: i64,
    lines: Vec<ProductQtyInput>,
) -> Result<CustomerReturnQuote, ReturnError> {
    let pool = sqlite_pool(&instances).await?;
    let mut conn = pool.acquire().await?;
    customer_quote_on(&mut conn, customer_id, &lines).await
}

#[tauri::command]
pub async fn create_customer_return(
    instances: State<'_, DbInstances>,
    request: CustomerReturnRequest,
) -> Result<CustomerReturnResult, ReturnError> {
    let pool = sqlite_pool(&instances).await?;
    create_customer_return_tx(&pool, &request).await
}

#[cfg(test)]
mod tests {
    use super::super::tests::{balance, count, customer, exec, migrated_db, open_shift, product, rt, sale, stock, walk_in};
    use super::*;

    fn pq(items: &[(i64, f64)]) -> Vec<ProductQtyInput> {
        items.iter().map(|(p, q)| ProductQtyInput { product_id: *p, qty: *q }).collect()
    }

    fn creq(cust: i64, items: &[(i64, f64)], cash: i64, card: i64, bal: i64) -> CustomerReturnRequest {
        CustomerReturnRequest {
            customer_id: cust,
            lines: pq(items),
            refund_cash: cash,
            refund_card: card,
            refund_balance: bal,
            reason: None,
        }
    }

    async fn quote(p: &SqlitePool, cust: i64, items: &[(i64, f64)]) -> Result<CustomerReturnQuote, ReturnError> {
        let mut c = p.acquire().await.unwrap();
        customer_quote_on(&mut c, cust, &pq(items)).await
    }

    fn alloc(amount: i64, cap: i64, suggested: i64) -> SaleAllocation {
        SaleAllocation {
            sale_id: 0,
            receipt_number: String::new(),
            created_at: String::new(),
            lines: vec![],
            amount,
            money_cap: cap,
            suggested_balance: suggested,
        }
    }

    #[test]
    fn allocates_newest_receipt_first_across_sales() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            let (s1, _) = sale(p, shift, c, &[(a, 1_000, 3.0)], 0, 3_000).await;
            let (s2, _) = sale(p, shift, c, &[(a, 1_200, 2.0)], 0, 2_400).await;

            // 4 dona: avval eng yangi chek (s2, 2 dona × 1 200), keyin s1 dan 2 dona.
            let q = quote(p, c, &[(a, 4.0)]).await.unwrap();
            assert_eq!(q.allocations.iter().map(|x| x.sale_id).collect::<Vec<_>>(), vec![s2, s1]);
            assert_eq!(q.allocations[0].lines[0].qty, 2.0);
            assert_eq!(q.allocations[1].lines[0].qty, 2.0);
            assert_eq!(q.amount, 2_400 + 2_000);
            assert_eq!(q.products[0].qty_remaining, 5.0);
            assert_eq!(q.products[0].last_price, 1_200.0);

            let r = create_customer_return_tx(p, &creq(c, &[(a, 4.0)], 4_400, 0, 0)).await.unwrap();
            assert_eq!(r.returns.len(), 2);
            assert_eq!(r.amount, 4_400);
            assert_eq!(stock(p, a).await, -1.0); // 0 − 5 sotilgan + 4 qaytgan
            // Qolgan 1 dona — eski chekda.
            let q = quote(p, c, &[]).await.unwrap();
            assert_eq!(q.products[0].qty_remaining, 1.0);
            assert!(q.allocations.is_empty());
        });
    }

    #[test]
    fn respects_returns_already_made_by_receipt() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            let (_, it1) = sale(p, shift, c, &[(a, 1_000, 2.0)], 0, 2_000).await;
            let (s2, it2) = sale(p, shift, c, &[(a, 1_000, 2.0)], 0, 2_000).await;
            super::super::create_return_tx(p, &super::super::tests::req(s2, &[(it2[0], 2.0)], 2_000, 0, 0)).await.unwrap();

            let e = create_customer_return_tx(p, &creq(c, &[(a, 3.0)], 3_000, 0, 0)).await.unwrap_err();
            assert_eq!(e.code, "qtyExceeds");
            assert_eq!(e.params["max"], json!(2.0));
            let q = quote(p, c, &[(a, 2.0)]).await.unwrap();
            assert_eq!(q.allocations.len(), 1);
            assert_eq!(q.allocations[0].lines[0].sale_item_id, it1[0]);
        });
    }

    #[test]
    fn rejects_walk_in_unknown_customer_and_unbought_product() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let w = walk_in(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            let b = product(p, "Shakar", 1_000, 0.0).await;
            sale(p, shift, w, &[(a, 1_000, 1.0)], 0, 1_000).await;
            sale(p, shift, c, &[(a, 1_000, 1.0)], 0, 1_000).await;

            assert_eq!(quote(p, w, &[]).await.unwrap_err().code, "walkInNeedsReceipt");
            assert_eq!(quote(p, 999_999, &[]).await.unwrap_err().code, "customerNotFound");
            assert_eq!(quote(p, c, &[(b, 1.0)]).await.unwrap_err().code, "productNotBought");
            assert_eq!(quote(p, c, &[(a, 1.0), (a, 1.0)]).await.unwrap_err().code, "duplicateLine");
            assert_eq!(quote(p, c, &[(a, f64::NAN)]).await.unwrap_err().code, "invalidQty");
            assert_eq!(
                create_customer_return_tx(p, &creq(c, &[], 0, 0, 0)).await.unwrap_err().code,
                "noLines"
            );
            assert_eq!(count(p, "sale_returns").await, 0);
        });
    }

    #[test]
    fn debt_is_closed_first_and_split_spreads_over_receipts() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 10_000, 0.0).await;
            // Eski chek to'langan, yangisi to'liq qarzga.
            let (s1, _) = sale(p, shift, c, &[(a, 10_000, 1.0)], 0, 10_000).await;
            let (s2, _) = sale(p, shift, c, &[(a, 10_000, 1.0)], 0, 0).await;
            assert_eq!(balance(p, c).await, -10_000);

            let q = quote(p, c, &[(a, 2.0)]).await.unwrap();
            assert_eq!((q.amount, q.money_cap, q.balance_min, q.suggested_balance), (20_000, 10_000, 10_000, 10_000));

            // Hammasi naqd — yangi chek pulsiz edi, rad.
            let e = create_customer_return_tx(p, &creq(c, &[(a, 2.0)], 20_000, 0, 0)).await.unwrap_err();
            assert_eq!(e.code, "cashExceedsCap");
            assert_eq!(e.params["max"], json!(10_000));

            // Taklif: 10 000 balansga (qarz yopiladi), 10 000 kartaga.
            let r = create_customer_return_tx(p, &creq(c, &[(a, 2.0)], 0, 10_000, 10_000)).await.unwrap();
            assert_eq!(balance(p, c).await, 0);
            let by_sale = |sid: i64| r.returns.iter().find(|x| x.sale_id == sid).unwrap().clone();
            assert_eq!((by_sale(s2).refund_balance, by_sale(s2).refund_card), (10_000, 0));
            assert_eq!((by_sale(s1).refund_balance, by_sale(s1).refund_card), (0, 10_000));
        });
    }

    #[test]
    fn failure_on_one_receipt_rolls_back_all() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            sale(p, shift, c, &[(a, 1_000, 1.0)], 0, 1_000).await;
            let (s2, _) = sale(p, shift, c, &[(a, 1_000, 1.0)], 0, 1_000).await;
            // Ikkinchi yoziladigan chek (eski, s1) yiqiladi — birinchisi (s2) ham qaytishi kerak.
            exec(
                p,
                &format!(
                    "CREATE TRIGGER boom BEFORE INSERT ON sale_returns WHEN NEW.sale_id <> {s2}
                     BEGIN SELECT RAISE(ABORT, 'boom'); END"
                ),
            )
            .await;
            let e = create_customer_return_tx(p, &creq(c, &[(a, 2.0)], 2_000, 0, 0)).await.unwrap_err();
            assert_eq!(e.code, "db");
            assert_eq!(count(p, "sale_returns").await, 0);
            assert_eq!(count(p, "sale_return_items").await, 0);
            assert_eq!(stock(p, a).await, -2.0);
        });
    }

    #[test]
    fn concurrent_customer_returns_cannot_exceed_remaining() {
        rt().block_on(async {
            let db = migrated_db().await;
            let p = &db.pool;
            let shift = open_shift(p).await;
            let c = customer(p).await;
            let a = product(p, "Choy", 1_000, 0.0).await;
            sale(p, shift, c, &[(a, 1_000, 2.0)], 0, 2_000).await;
            sale(p, shift, c, &[(a, 1_000, 1.0)], 0, 1_000).await;
            let spawn = || {
                let (pool, r) = (p.clone(), creq(c, &[(a, 2.0)], 2_000, 0, 0));
                tokio::spawn(async move { create_customer_return_tx(&pool, &r).await })
            };
            let (hx, hy) = (spawn(), spawn());
            let (x, y) = (hx.await.unwrap(), hy.await.unwrap());
            assert_eq!([x.is_ok(), y.is_ok()].iter().filter(|o| **o).count(), 1, "{x:?} / {y:?}");
            assert_eq!(x.err().or(y.err()).unwrap().code, "qtyExceeds");
            assert_eq!(stock(p, a).await, -1.0);
        });
    }

    #[test]
    fn split_respects_each_receipt_bounds() {
        // (summa, pul chegarasi, taklif balans)
        let a = [alloc(10_000, 0, 10_000), alloc(10_000, 10_000, 0), alloc(5_000, 5_000, 0)];
        // Minimal balans 10 000; qo'shimcha 2 000 → taklifi bo'lmagani uchun 2-chekka.
        let s = split_refunds(&a, 3_000, 10_000, 12_000).unwrap();
        assert_eq!(s, vec![(0, 0, 10_000), (0, 8_000, 2_000), (3_000, 2_000, 0)]);
        for ((cash, card, bal), x) in s.iter().zip(&a) {
            assert_eq!(cash + card + bal, x.amount);
            assert!(cash + card <= x.money_cap);
        }
        assert_eq!(split_refunds(&a, 25_000, 0, 0).unwrap_err().code, "cashExceedsCap");
        assert_eq!(split_refunds(&a, 1, 0, 0).unwrap_err().code, "refundMismatch");
        assert_eq!(split_refunds(&a, -1, 0, 25_001).unwrap_err().code, "refundNegative");
        assert_eq!(split_refunds(&[], 0, 0, 0).unwrap(), vec![]);
    }
}
