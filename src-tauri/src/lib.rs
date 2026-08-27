use tauri_plugin_sql::{Migration, MigrationKind};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};
use serde::Serialize;
use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Windows: bola jarayon (powershell/mspaint) qora konsol oynasini ochmasin.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// QOIDA: bu fayldagi hech bir buyruq main thread'ni bloklamasligi kerak.
// Tauri'da `async` bo'lmagan #[tauri::command] AYNAN main thread'da bajariladi
// (tauri-macros: ExecutionContext::Blocking -> kind "sync"). Windows'da o'sha
// yerda `Get-Printer`/mspaint kutish WebView2 xabar sikliniyam to'xtatadi —
// butun dastur muzlaydi. Shu sabab sekin ishlar spawn_blocking + timeout ichida.
// Xuddi shunday, BLE chaqiruvlari vaqt chegarasiz qolsa buyruq abadiy osiladi.
// ---------------------------------------------------------------------------

const PRINTER_QUERY_TIMEOUT: Duration = Duration::from_secs(8);
const PRINTER_CACHE_TTL: Duration = Duration::from_secs(60);
const PRINT_JOB_TIMEOUT: Duration = Duration::from_secs(90);

const BLE_IO_TIMEOUT: Duration = Duration::from_secs(8);
const BLE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const BLE_GATE_TIMEOUT: Duration = Duration::from_secs(30);
const BLE_SCAN_WINDOW: Duration = Duration::from_millis(4000);

#[derive(Default)]
pub struct BtState {
    pub connected_peripheral: Arc<Mutex<Option<Peripheral>>>,
    // Adapter keshi. Har skanda yangi Manager/Adapter yaratish Windows'da har safar
    // yangi BluetoothLEAdvertisementWatcher + radio StateChanged handler qo'shadi
    // (btleplug winrtble/adapter.rs) — ular hech qachon olib tashlanmaydi.
    pub adapter: Arc<Mutex<Option<Adapter>>>,
    // Radio bilan bir vaqtda faqat bitta amal: skan/ulanish/yozish ustma-ust tushmasin.
    pub gate: Arc<Mutex<()>>,
}

#[derive(Default)]
pub struct PrinterState {
    // Oxirgi muvaffaqiyatli ro'yxat + olingan vaqti.
    cache: Mutex<Option<(Instant, Vec<String>)>>,
    // Bir vaqtning o'zida bitta so'rov: takroriy `Get-Printer` navbat yig'masin.
    query: Mutex<()>,
}

#[derive(Serialize, Clone)]
pub struct BlePrinter {
    pub id: String,
    pub name: String,
}

// btleplug chaqiruvini vaqt chegarasiga o'raydi. Windows BLE steki javob bermay
// qolsa buyruq xato qaytaradi — osilib qolmaydi.
async fn ble<T, F>(what: &str, limit: Duration, fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = btleplug::Result<T>>,
{
    match timeout(limit, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("{what}: {e}")),
        Err(_) => Err(format!("{what}: {}s ichida javob bermadi", limit.as_secs())),
    }
}

async fn ble_adapter(state: &BtState) -> Result<Adapter, String> {
    if let Some(a) = state.adapter.lock().await.clone() {
        return Ok(a);
    }
    let manager = ble("Bluetooth manager", BLE_IO_TIMEOUT, Manager::new()).await?;
    let adapters = ble("Bluetooth adapterlari", BLE_IO_TIMEOUT, manager.adapters()).await?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or_else(|| "Bluetooth adapteri topilmadi".to_string())?;
    *state.adapter.lock().await = Some(adapter.clone());
    Ok(adapter)
}

// Adapter shubhali bo'lsa keshdan chiqaramiz — keyingi urinish yangisini oladi.
async fn drop_ble_adapter(state: &BtState) {
    *state.adapter.lock().await = None;
}

#[tauri::command]
async fn scan_bluetooth_printers(state: tauri::State<'_, BtState>) -> Result<Vec<BlePrinter>, String> {
    // Skan navbat kutmaydi: oldingisi tugamagan bo'lsa darhol xato.
    let _gate = state
        .gate
        .try_lock()
        .map_err(|_| "Bluetooth band: oldingi amal tugamadi".to_string())?;

    let central = match ble_adapter(&state).await {
        Ok(c) => c,
        Err(e) => {
            log::warn!("BLE scan: {e}");
            drop_ble_adapter(&state).await;
            return Err(e);
        }
    };

    log::info!("Starting Bluetooth scan...");
    if let Err(e) = ble(
        "Skanni boshlash",
        BLE_IO_TIMEOUT,
        central.start_scan(ScanFilter::default()),
    )
    .await
    {
        log::warn!("BLE start_scan failed: {e}");
        drop_ble_adapter(&state).await;
        return Err(e);
    }

    sleep(BLE_SCAN_WINDOW).await;

    if let Err(e) = ble("Skanni to'xtatish", BLE_IO_TIMEOUT, central.stop_scan()).await {
        // To'xtatolmadik — watcher yoqiq qolishi mumkin, adapterni tashlaymiz.
        log::warn!("BLE stop_scan failed: {e}");
        drop_ble_adapter(&state).await;
    }

    let peripherals = match ble("Qurilmalar ro'yxati", BLE_IO_TIMEOUT, central.peripherals()).await {
        Ok(p) => p,
        Err(e) => {
            log::warn!("BLE peripherals failed: {e}");
            drop_ble_adapter(&state).await;
            return Err(e);
        }
    };

    log::info!("Found {} Bluetooth peripherals in total", peripherals.len());
    let mut printers = Vec::new();
    for p in peripherals {
        let props = match timeout(BLE_IO_TIMEOUT, p.properties()).await {
            Ok(Ok(Some(props))) => props,
            _ => continue,
        };
        let name = props.local_name.unwrap_or_else(|| {
            let id_str = p.id().to_string();
            let short_id: String = id_str.chars().take(8).collect();
            format!("BT Device ({})", short_id)
        });
        log::info!("BLE Discovered device: ID={}, Name={}", p.id(), name);
        printers.push(BlePrinter {
            id: p.id().to_string(),
            name,
        });
    }
    log::info!("BLE scan finished: {} device(s)", printers.len());
    Ok(printers)
}

#[tauri::command]
async fn connect_bluetooth_printer(id: String, state: tauri::State<'_, BtState>) -> Result<(), String> {
    // 1. Shu qurilmaga ishlaydigan ulanish allaqachon bor bo'lsa qayta ulanmaymiz.
    {
        let active = state.connected_peripheral.lock().await;
        if let Some(p) = active.as_ref() {
            if p.id().to_string() == id {
                if let Ok(Ok(true)) = timeout(BLE_IO_TIMEOUT, p.is_connected()).await {
                    log::info!("Already connected to peripheral {}", id);
                    return Ok(());
                }
            }
        }
    } // qulf shu yerda bo'shaydi

    let _gate = timeout(BLE_GATE_TIMEOUT, state.gate.lock())
        .await
        .map_err(|_| "Bluetooth band: oldingi amal tugamadi".to_string())?;

    let central = ble_adapter(&state).await?;

    let mut target_peripheral = ble("Qurilmalar ro'yxati", BLE_IO_TIMEOUT, central.peripherals())
        .await?
        .into_iter()
        .find(|p| p.id().to_string() == id);

    // Qurilma faol keshda bo'lmasa — qisqa dinamik skan.
    if target_peripheral.is_none() {
        log::info!("Peripheral {} not in active cache. Starting dynamic scan...", id);
        if let Err(e) = ble(
            "Skanni boshlash",
            BLE_IO_TIMEOUT,
            central.start_scan(ScanFilter::default()),
        )
        .await
        {
            log::warn!("BLE start_scan failed: {e}");
            drop_ble_adapter(&state).await;
            return Err(e);
        }

        let mut scan_err: Option<String> = None;
        // 5 soniyagacha (10 x 500ms) kutamiz.
        for _ in 0..10 {
            sleep(Duration::from_millis(500)).await;
            let list = match ble("Qurilmalar ro'yxati", BLE_IO_TIMEOUT, central.peripherals()).await {
                Ok(l) => l,
                Err(e) => {
                    scan_err = Some(e);
                    break;
                }
            };
            target_peripheral = list.into_iter().find(|p| p.id().to_string() == id);
            if target_peripheral.is_some() {
                log::info!("Peripheral {} found during scan!", id);
                break;
            }
        }

        // Xato bo'lsa ham skanni albatta to'xtatamiz — watcher yoqiq qolmasin.
        if let Err(e) = ble("Skanni to'xtatish", BLE_IO_TIMEOUT, central.stop_scan()).await {
            log::warn!("BLE stop_scan failed: {e}");
            drop_ble_adapter(&state).await;
        }
        if let Some(e) = scan_err {
            drop_ble_adapter(&state).await;
            return Err(e);
        }
    }

    let target_peripheral = target_peripheral
        .ok_or_else(|| "Peripheral not found in scan list. Please make sure the printer is turned on and not connected to other devices (like Chrome or mobile phone).".to_string())?;

    let mut active = state.connected_peripheral.lock().await;

    // Boshqa qurilma ulangan bo'lsa uzamiz.
    if let Some(p) = active.as_ref() {
        let _ = timeout(BLE_IO_TIMEOUT, p.disconnect()).await;
    }
    *active = None;

    log::info!("Connecting to peripheral {}...", id);
    ble("Ulanish", BLE_CONNECT_TIMEOUT, target_peripheral.connect()).await?;
    ble(
        "Servislarni aniqlash",
        BLE_CONNECT_TIMEOUT,
        target_peripheral.discover_services(),
    )
    .await?;

    *active = Some(target_peripheral);
    Ok(())
}

#[tauri::command]
async fn disconnect_bluetooth_printer(state: tauri::State<'_, BtState>) -> Result<(), String> {
    let mut active = state.connected_peripheral.lock().await;
    if let Some(p) = active.as_ref() {
        let _ = timeout(BLE_IO_TIMEOUT, p.disconnect()).await;
    }
    *active = None;
    Ok(())
}

#[tauri::command]
async fn write_bluetooth_printer(bytes: Vec<u8>, state: tauri::State<'_, BtState>) -> Result<(), String> {
    let _gate = timeout(BLE_GATE_TIMEOUT, state.gate.lock())
        .await
        .map_err(|_| "Bluetooth band: oldingi amal tugamadi".to_string())?;

    let active = state.connected_peripheral.lock().await;
    let peripheral = active.as_ref().ok_or("No printer connected")?;

    let chars = peripheral.characteristics();
    let write_char = chars.iter().find(|c| {
        c.properties.contains(btleplug::api::CharPropFlags::WRITE) ||
        c.properties.contains(btleplug::api::CharPropFlags::WRITE_WITHOUT_RESPONSE)
    }).ok_or("No writable BLE characteristic found on the printer")?;

    let write_type = if write_char.properties.contains(btleplug::api::CharPropFlags::WRITE_WITHOUT_RESPONSE) {
        WriteType::WithoutResponse
    } else {
        WriteType::WithResponse
    };

    let chunk_size = 128;
    for chunk in bytes.chunks(chunk_size) {
        ble(
            "Printerga yozish",
            BLE_IO_TIMEOUT,
            peripheral.write(write_char, chunk, write_type),
        )
        .await?;
        sleep(Duration::from_millis(5)).await;
    }

    Ok(())
}

fn parse_printer_lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

// Tizimda o'rnatilgan printerlar. Bloklovchi ish — faqat spawn_blocking ichida chaqiriladi.
fn query_system_printers() -> Vec<String> {
    #[cfg(not(target_os = "windows"))]
    {
        // CUPS: `lpstat -e` har qatorda bitta printer nomi.
        if let Ok(out) = Command::new("lpstat").arg("-e").output() {
            return parse_printer_lines(&out.stdout);
        }
        Vec::new()
    }
    #[cfg(target_os = "windows")]
    {
        // Get-Printer uzilgan tarmoq/WSD printer bo'lsa bir necha daqiqa osilishi mumkin —
        // shuning uchun chaqiruvchi tomonda timeout + kesh bor.
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Printer | Select-Object -ExpandProperty Name",
        ]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = cmd.output() {
            return parse_printer_lines(&out.stdout);
        }
        Vec::new()
    }
}

// Tizimda o'rnatilgan printerlar ro'yxati (browsersiz pechat uchun tanlash).
// `force = true` keshni chetlab o'tadi (Sozlamalardagi "Yangilash" tugmasi).
#[tauri::command]
async fn list_printers(
    force: Option<bool>,
    state: tauri::State<'_, PrinterState>,
) -> Result<Vec<String>, String> {
    list_printers_inner(&state, force.unwrap_or(false), query_system_printers).await
}

// Buyruqning testlanadigan yadrosi. `query` — bloklovchi ro'yxat olish funksiyasi.
async fn list_printers_inner<Q>(
    state: &PrinterState,
    force: bool,
    query: Q,
) -> Result<Vec<String>, String>
where
    Q: FnOnce() -> Vec<String> + Send + 'static,
{
    if !force {
        if let Some((at, names)) = state.cache.lock().await.as_ref() {
            if at.elapsed() < PRINTER_CACHE_TTL {
                return Ok(names.clone());
            }
        }
    }

    // Oldingi so'rov hali ketayotgan bo'lsa yangisini boshlamaymiz: sekin
    // `Get-Printer` chaqiruvlari navbat bo'lib yig'ilib qolmasin.
    let _busy = match state.query.try_lock() {
        Ok(g) => g,
        Err(_) => {
            let cached = state.cache.lock().await.as_ref().map(|(_, n)| n.clone());
            return Ok(cached.unwrap_or_default());
        }
    };

    let job = tauri::async_runtime::spawn_blocking(query);
    match timeout(PRINTER_QUERY_TIMEOUT, job).await {
        Ok(Ok(names)) => {
            *state.cache.lock().await = Some((Instant::now(), names.clone()));
            Ok(names)
        }
        Ok(Err(e)) => Err(format!("Printer ro'yxatini olishda xato: {e}")),
        Err(_) => {
            // Osilib qolgan so'rov UI ni kutdirmaydi — oxirgi ma'lum ro'yxat qaytadi.
            log::warn!(
                "list_printers: {}s ichida javob bermadi (Get-Printer/lpstat osilgan)",
                PRINTER_QUERY_TIMEOUT.as_secs()
            );
            let cached = state.cache.lock().await.as_ref().map(|(_, n)| n.clone());
            Ok(cached.unwrap_or_default())
        }
    }
}

// PowerShell string literali uchun qo'shtirnoqni ekranlash.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

// Rasmni printerga yuboradigan PowerShell skripti (System.Drawing.Printing).
//
// Nega mspaint emas: Windows 11 da `mspaint /pt` ishonchsiz — yangi Paint (Store
// ilovasi) bu bayroqni qo'llab-quvvatlamaydi, ya'ni chek jimgina chop etilmaydi
// yoki oyna ochilib qoladi. System.Drawing.Printing esa Windows PowerShell 5.1
// (tizimda doim bor) orqali to'g'ridan-to'g'ri drayverga yuboradi.
//
// Masshtab: rasm sahifa KENGLIGIGA moslanadi (nisbat saqlanadi). Uzun chek
// sahifaga sig'masa vertikal bo'laklarga bo'linadi (HasMorePages).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn powershell_print_script(path: &str, printer: Option<&str>, copies: u32) -> String {
    let printer_line = match printer {
        Some(p) if !p.is_empty() => format!(
            "$doc.PrinterSettings.PrinterName = {};\n",
            ps_quote(p)
        ),
        _ => String::new(),
    };
    format!(
        r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$script:img = [System.Drawing.Image]::FromFile({path})
if ($script:img.Width -le 0) {{ throw 'Rasm bo''sh (kengligi 0)' }}
try {{
  $doc = New-Object System.Drawing.Printing.PrintDocument
  {printer_line}  if (-not $doc.PrinterSettings.IsValid) {{ throw "Printer topilmadi: $($doc.PrinterSettings.PrinterName)" }}
  $doc.DocumentName = 'OpenSales POS'
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
  $doc.OriginAtMargins = $false
  $script:printed = 0.0
  $doc.add_PrintPage({{
    param($sender, $e)
    $g = $e.Graphics
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $pw = $e.PageBounds.Width
    $ph = $e.PageBounds.Height
    $scale = $pw / $script:img.Width
    $totalH = $script:img.Height * $scale
    $sliceH = [Math]::Min($ph, $totalH - $script:printed)
    $src = New-Object System.Drawing.RectangleF(0, ($script:printed / $scale), $script:img.Width, ($sliceH / $scale))
    $dst = New-Object System.Drawing.RectangleF(0, 0, $pw, $sliceH)
    $g.DrawImage($script:img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
    $script:printed += $sliceH
    $e.HasMorePages = ($script:printed -lt ($totalH - 1))
  }})
  for ($i = 0; $i -lt {copies}; $i++) {{
    $script:printed = 0.0
    $doc.Print()
  }}
}} finally {{
  $script:img.Dispose()
}}
"#,
        path = ps_quote(path),
        printer_line = printer_line,
        copies = copies
    )
}

// PowerShell -EncodedCommand UTF-16LE + base64 kutadi. Shu ko'rinish uzun
// skriptdagi qo'shtirnoq/qavslar bilan bog'liq barcha ekranlash muammosini yo'q qiladi.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn encode_powershell_command(script: &str) -> String {
    let mut utf16 = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    base64_encode(&utf16)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

// Faylni (PNG) to'g'ridan-to'g'ri printerga yuboradi — brauzersiz.
// printer bo'sh bo'lsa standart printer ishlatiladi.
fn run_print_job(path: &str, printer: Option<&str>, copies: u32) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("lp");
        if let Some(p) = printer {
            if !p.is_empty() {
                cmd.arg("-d").arg(p);
            }
        }
        if copies > 1 {
            cmd.arg("-n").arg(copies.to_string());
        }
        cmd.arg(path);
        let status = cmd.status().map_err(|e| format!("lp ishga tushmadi: {e}"))?;
        if !status.success() {
            return Err("Printerga yuborishda xato (lp)".into());
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let script = powershell_print_script(path, printer, copies);
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
        ])
        .arg(encode_powershell_command(&script));
        cmd.creation_flags(CREATE_NO_WINDOW);

        // PowerShell yo'li asosiy. Qanday sabab bilan bo'lmasin muvaffaqiyatsiz
        // bo'lsa — eski mspaint yo'liga qaytamiz: Windows 10 da u hali ishlaydi,
        // ya'ni chek chiqmay qolgandan ko'ra urinib ko'rgan yaxshi.
        let ps_err = match cmd.output() {
            Ok(out) if out.status.success() => return Ok(()),
            Ok(out) => {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if err.is_empty() {
                    "PowerShell pechat xatosi".to_string()
                } else {
                    err
                }
            }
            Err(e) => format!("powershell ishga tushmadi: {e}"),
        };
        log::warn!("print_file: {ps_err} — mspaint bilan urinamiz");

        match print_via_mspaint(path, printer, copies) {
            Ok(()) => Ok(()),
            // Ikkalasi ham bo'lmadi — PowerShell xatosi ko'proq ma'lumot beradi.
            Err(mspaint_err) => {
                log::warn!("print_file: mspaint ham bo'lmadi: {mspaint_err}");
                Err(ps_err)
            }
        }
    }
}

// Zaxira yo'l: PowerShell mavjud bo'lmasa. Windows 11 da ishonchsiz.
#[cfg(target_os = "windows")]
fn print_via_mspaint(path: &str, printer: Option<&str>, copies: u32) -> Result<(), String> {
    for _ in 0..copies {
        let mut cmd = Command::new("mspaint");
        match printer {
            Some(p) if !p.is_empty() => {
                cmd.args(["/pt", path, p]);
            }
            _ => {
                cmd.args(["/p", path]);
            }
        }
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.status().map_err(|e| format!("mspaint ishga tushmadi: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn print_file(path: String, printer: Option<String>, copies: Option<u32>) -> Result<(), String> {
    let n = copies.unwrap_or(1).max(1);
    let job = tauri::async_runtime::spawn_blocking(move || {
        run_print_job(&path, printer.as_deref(), n)
    });
    match timeout(PRINT_JOB_TIMEOUT, job).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(format!("Pechat vazifasi uzildi: {e}")),
        Err(_) => Err(format!(
            "Printer {}s ichida javob bermadi",
            PRINT_JOB_TIMEOUT.as_secs()
        )),
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
    Migration {
        version: 9,
        description: "expenses",
        // Do'kon xarajatlari (ijara, oylik, kommunal, tovar olib kelish va h.k.).
        // Hisobotда sof foyda = savdo foydasi − xarajatlar.
        sql: r#"
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'Boshqa',
  note TEXT,
  shift_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at);
"#,
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
        .manage(BtState::default())
        .manage(PrinterState::default())
        .invoke_handler(tauri::generate_handler![
            list_printers,
            print_file,
            scan_bluetooth_printers,
            connect_bluetooth_printer,
            disconnect_bluetooth_printer,
            write_bluetooth_printer
        ])
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

#[cfg(test)]
mod tests {
    use super::*;

    // `#[tokio::test]` ishlatilmaydi — u tokio "macros" featureни talab qiladi,
    // bu yerda runtime qo'lda quriladi (mavjud featurelar bilan yetarli).
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_time()
            .build()
            .expect("tokio runtime")
    }

    #[test]
    fn parse_printer_lines_trims_and_skips_empty() {
        let out = b"  HP_LaserJet \n\n Xprinter_XP58 \r\n";
        assert_eq!(
            parse_printer_lines(out),
            vec!["HP_LaserJet".to_string(), "Xprinter_XP58".to_string()]
        );
    }

    // Tizim printerlarini so'rash bloklovchi ish (lpstat / powershell Get-Printer).
    // U main thread'da emas, blocking pool'da bajarilishi va timeout ichida
    // tugashi kerak — aks holda Sozlamalar sahifasi butun oynani muzlatadi.
    #[test]
    fn system_printer_query_finishes_within_timeout() {
        rt().block_on(async {
            let job = tokio::task::spawn_blocking(query_system_printers);
            assert!(
                timeout(PRINTER_QUERY_TIMEOUT, job).await.is_ok(),
                "printer ro'yxati {}s ichida tugamadi",
                PRINTER_QUERY_TIMEOUT.as_secs()
            );
        });
    }

    // Javob bermaydigan BLE chaqiruvi buyruqni abadiy osib qo'ymasligi kerak.
    #[test]
    fn ble_wrapper_times_out_instead_of_hanging() {
        rt().block_on(async {
            let r = ble(
                "Sinov",
                Duration::from_millis(50),
                std::future::pending::<btleplug::Result<()>>(),
            )
            .await;
            let err = r.expect_err("timeout xato qaytarishi kerak edi");
            assert!(err.contains("javob bermadi"), "kutilmagan xato: {err}");
        });
    }

    #[test]
    fn printer_list_is_cached_and_force_refetches() {
        let state = PrinterState::default();
        rt().block_on(async {
            let first = list_printers_inner(&state, false, || vec!["A".to_string()])
                .await
                .unwrap();
            assert_eq!(first, vec!["A".to_string()]);

            // Kesh amal qiladi: yangi query chaqirilmaydi.
            let cached = list_printers_inner(&state, false, || vec!["B".to_string()])
                .await
                .unwrap();
            assert_eq!(cached, vec!["A".to_string()]);

            // force = true → keshni chetlab o'tadi.
            let forced = list_printers_inner(&state, true, || vec!["B".to_string()])
                .await
                .unwrap();
            assert_eq!(forced, vec!["B".to_string()]);
        });
    }

    // Osilib qolgan so'rov UI ni kutdirmasin: timeoutdan keyin oxirgi ma'lum
    // ro'yxat qaytadi va buyruq xato bermaydi.
    #[test]
    fn printer_list_falls_back_to_cache_on_timeout() {
        let state = PrinterState::default();
        rt().block_on(async {
            list_printers_inner(&state, false, || vec!["A".to_string()])
                .await
                .unwrap();
            *state.cache.lock().await = Some((
                Instant::now() - PRINTER_CACHE_TTL - Duration::from_secs(1),
                vec!["A".to_string()],
            ));
            let slow = list_printers_inner(&state, true, || {
                std::thread::sleep(PRINTER_QUERY_TIMEOUT + Duration::from_millis(200));
                vec!["B".to_string()]
            });
            assert_eq!(slow.await.unwrap(), vec!["A".to_string()]);
        });
    }

    // -EncodedCommand UTF-16LE + base64 kutadi. Noto'g'ri kodlash = PowerShell
    // skriptni umuman tushunmaydi, ya'ni chek jimgina chop etilmaydi.
    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn powershell_command_is_utf16le_base64() {
        // "AB" -> UTF-16LE 41 00 42 00
        assert_eq!(encode_powershell_command("AB"), base64_encode(&[0x41, 0x00, 0x42, 0x00]));
    }

    // Printer nomida apostrof bo'lsa skript buzilmasligi kerak.
    #[test]
    fn printer_name_quote_is_escaped() {
        assert_eq!(ps_quote("Bob's XP-58"), "'Bob''s XP-58'");
        let script = powershell_print_script("C:\\tmp\\chek.png", Some("Bob's XP-58"), 2);
        assert!(script.contains("'Bob''s XP-58'"), "{script}");
        assert!(script.contains("$doc.PrinterSettings.PrinterName ="));
        assert!(script.contains("for ($i = 0; $i -lt 2; $i++)"));
    }

    // Printer tanlanmagan bo'lsa standart printer ishlatiladi (PrinterName qo'yilmaydi).
    #[test]
    fn default_printer_when_none_selected() {
        let script = powershell_print_script("C:\\tmp\\chek.png", None, 1);
        assert!(!script.contains("PrinterName ="), "{script}");
    }

    // btleplug xatosi jim yutilmasin — matn sifatida yuqoriga qaytadi.
    #[test]
    fn ble_wrapper_forwards_error() {
        rt().block_on(async {
            let fut = async { Err::<(), _>(btleplug::Error::DeviceNotFound) };
            let err = ble("Sinov", Duration::from_secs(5), fut)
                .await
                .expect_err("xato kutilgan edi");
            assert!(err.starts_with("Sinov: "), "kutilmagan xato: {err}");
        });
    }
}
