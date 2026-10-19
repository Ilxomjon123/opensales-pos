# OpenSales POS — qoidalar

Tauri 2 + Vue 3 + TS + Tailwind v4 + SQLite (tauri-plugin-sql). Mantiq TypeScriptda.
Sotish uchun offline desktop POS. Build: `npm run build` (vue-tsc+vite) → `npx tauri build`.

## Ma'lumotni saqlash — BUZMA

Baza: `~/Library/Application Support/uz.opensales.pos/pos.db` (Win: `%APPDATA%\uz.opensales.pos\pos.db`).
Dastur faylidan alohida → yangi versiya o'rnatilganda ma'lumot o'chmaydi.
PIN, `device_id`, `install_date`, `license_key`, `license_revoked`, sozlamalar — hammasi `settings` jadvalida (o'sha db).

Yangilash ma'lumotni saqlashi uchun:
1. **Identifier o'zgarmasin** — `uz.opensales.pos` (tauri.conf.json). O'zgarsa yangi papka → bo'sh ko'rinadi.
2. **Eski migratsiyani tahrirlama / DROP qilma.** Faqat yangi `version` qo'sh (lib.rs).
3. Yangi ustun → yangi migratsiya `ALTER TABLE ... ADD COLUMN` (v2/v3 kabi).
4. `seedIfEmpty` faqat bo'sh bazada ishlaydi (mijozlar bo'sh bo'lsa). Mahsulot/kategoriya seed yo'q — egasi o'zi qo'shadi.
5. **Eski bazalarda migratsiyalar v7 da tiqilgan**: `healSchema` `barcode_type` ni oldin qo'shgani uchun v8 `ADD COLUMN` har safar yiqiladi, plagin qolganini qo'llamaydi (v9+ hech qachon ishlamaydi). Yangi jadval faqat migratsiyaga tayanmasin — `CREATE TABLE IF NOT EXISTS` self-heal ham bo'lsin (expenses: `healSchema`; vozvrat: `ensure_returns_schema`, DDL `returns.rs` dagi bitta konstanta).

## Vozvrat (`src-tauri/src/returns.rs`)

- Mantiq Rust'da, bitta `BEGIN IMMEDIATE` tranzaksiyada: JS'da tranzaksiya yo'q (plagin pool'ida har `execute` alohida ulanish). Qoldiq + pul + balans yarim yozilmasin.
- `return_quote` (UI summani shundan oladi) va `create_return` bitta `compute()` ni ishlatadi — formula TS'da takrorlanmaydi.
- Summa: chegirma proporsional, jamlanib hisoblanadi → bir chek bo'yicha barcha vozvratlar = aynan `sales.total`. Pul (naqd/karta) ≤ chek uchun olingan pul, yoki balansdan keyin mijoz qarzdor qolmasa ko'proq; qolgani balansga. Yo'l-yo'lakayga balans yo'q. Smena ochiq bo'lishi shart; vozvrat qaytarilgan paytdagi smenaga yoziladi.
- Real bazada INTEGER ustunlarda kasr bor (`cost_price` 12527.2) — Rust'da pul ustunlari `CAST(ROUND())`, narx/tannarx `CAST(.. AS REAL)` bilan o'qiladi (sqlx turini qat'iy tekshiradi).
- Hisoblarga ta'siri: `customerMovements` (+ `refund_balance`), `shiftStats` (kutilgan naqd − `refund_cash`), Hisobot (vozvrat sanasi bo'yicha ayiriladi, foyda sotuvdagi formulaning teskarisi).
- Testlar: `cargo test --lib returns` — real migratsiyalar qo'llangan fayl bazada (parallel ikki vozvrat, xatoda rollback va h.k.).

## Kamera (`src-tauri/src/camera.rs`, `lib/camera.ts`)

- `Info.plist` da `NSCameraUsageDescription` SHART — kalitsiz macOS ruxsat oynasini umuman chiqarmaydi, getUserMedia jim rad etiladi.
- macOS: holat AVFoundation'dan o'qiladi; `prompt` bo'lsa tizim oynasi ochiladi, `denied` bo'lsa skanerda "Ruxsat berish" → Tizim sozlamalari → Kamera. Oyna fokusga qaytganda o'zi qayta urinadi.

## Litsenziya (Ed25519, offline)

- Dasturda FAQAT public kalit (`src/lib/license.ts`). Private seed faqat egasida, hech qachon build ichiga joylanmaydi.
- 1-marta o'rnatishda avtomatik 15 kun sinov. Muddat tugasa → `/activate` ekrani bloklaydi.
- Kalit har PC ga bog'liq (`device_id`). Deterministik: bir xil (deviceId + exp + seed) = bir xil kalit.
- Generator: aktivatsiya ekranida logoga 5 marta bos YOKI Sozlamalar→Litsenziya kalit ikonkasini 5 marta bos → master kalit → seed + muddat → kalit.
- Bekor qilish: generatordagi qizil tugma → `license_revoked=1` → dastur aktivatsiyani kutadi.
- Maxfiy qiymatlar `.env`da (`VITE_*`), DB'da emas: `VITE_OWNER_MASTER_HASH`, `VITE_DEFAULT_PIN`, `VITE_INTEGRITY_SECRET`. Private seed kodda yo'q — parol menejerda.
- Master kalitning OCHIQ matni hech qayerda saqlanmaydi. `.env`da faqat `VITE_OWNER_MASTER_HASH` = SHA-512(KALIT), bitta raund — kalitni tekshirish shu bilan (`auth.ts` PIN tiklash va `license.ts isOwnerMaster()` ikkalasi ham). 200 000 raundli zanjir ALOHIDA narsa: u faqat `ownerProof()` — Cloudflare backup-worker'ga `X-Owner-Proof` sifatida boradi, worker sirida shu qiymat turishi kerak. Ikkalasini aralashtirma.

## UI

- Bo'lim layout standarti (Mahsulotlar/Mijozlar/Smenalar/Kategoriyalar/Sotuvlar): header + stat kartalar (bosilsa filter) + filter bar + sticky `bg-muted` thead + tfoot "Jami". Cyrillic/Latin farqsiz `translitMatch`.
- Tauri WKWebViewda `window.confirm/alert/print` ishlamaydi → `lib/confirm.ts`, `lib/notify.ts`, `lib/print.ts` (HTML→AppCache→opener).
- Modal tashqarisi bosilganda yopilmasin (faqat tugma). Action tugmalar doim ko'rinsin (hover emas).
- Mahsulot rasmi yuklanganda webp (max 512px) ga siqiladi (`Products.vue compressImage`); WebKit webp encode'siz jpeg fallback.

## Release & auto-update (`lib/updater.ts`)

- Kod private `opensales-pos`. Installerlar + `latest.json` PUBLIC `opensales-pos-releases` da (updater private repodan o'qiy olmaydi).
- Release oqimi: `tauri.conf.json` version oshir → `git tag vX.Y.Z` → push. CI (`.github/workflows/build.yml`): build matritsa (mac+win) tauri-action bilan imzolaydi → private draft release'ga; `publish` job draft'dan yuklab, `latest.json` URL larini public repoga sed-almashtiradi, public release yaratadi (PUB ochiq repo bo'sh bo'lsa README commit kerak — aks holda 422).
- Updater imzo kaliti: public `tauri.conf.json plugins.updater.pubkey`; private+parol GH secrets `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`. Public repoga yozish: secret `GH_RELEASES_TOKEN` (user PAT).
- App: ochilganda 3s keyin fonda `checkForUpdate()` (8s timeout — offline'da osilmaydi). Banner = `UpdatePrompt.vue` (burchak, modal emas). Sozlamalar→Yangilanish→Tekshirish ham bor.

## Backup (`lib/backup.ts`)

- Kunlik lokal nusxa (VACUUM INTO — WAL bilan toza), AppData/`backups/`, oxirgi 14 ta. Internet bo'lsa fonda GitHub'ga sync.
- GitHub sync: private `opensales-pos-backups`, yo'l `backups/<deviceId>/pos-*.db` + `_info.json` (shop_name + host). Ilovada GitHub tokeni YO'Q — hammasi Cloudflare worker orqali (`VITE_BACKUP_PROXY_URL`, `cloudflare/backup-worker.js`); worker device_id + license_key bilan avtorizatsiya qiladi, boshqa qurilma papkasini o'qishda `X-Owner-Proof` talab qiladi.
- Tiklash OQ EKRAN bermasligi uchun: ochiq pos.db ustiga yozma. `restoreBackup` marker (`restore_pending`) yozadi + relaunch; `applyPendingRestore()` main.ts'da DB ochilishidan OLDIN almashtiradi.
- Zaxira bo'limi (Sozlamalar) owner-master bilan yashirin: "Sozlamalar" sarlavhasini 5 marta bos → master kalit. GitHub'dan tiklash searchable select (shop · host · id).
