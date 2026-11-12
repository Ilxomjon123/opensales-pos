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
- Mijoz bo'yicha vozvrat (`returns/customer.rs`, Mijoz sahifasi → "Vozvrat"): tovar + miqdor → mijozning cheklariga ENG YANGISIDAN taqsimlanadi, har chekka alohida `create_on`, hammasi bitta tranzaksiyada. Umumiy pul `split_refunds` bilan cheklarga bo'linadi (har chekda balans ∈ [summa − pul chegarasi, summa]). Yo'l-yo'lakay xaridorga YO'Q — sotuvlari umumiy, bu cheksiz vozvratga aylanadi; u chek bo'yicha qaytaradi.
- Pul taqsimoti UI'si bitta: `RefundSplit.vue` (ikkala modal ham ishlatadi).
- "Vozvratlar" bo'limi (`pages/Returns.vue`, `/returns`): barcha vozvratlar (bo'lim standarti bo'yicha) + "Yangi vozvrat" (`NewReturnModal` → chek yoki mijoz bo'yicha oyna). Usul filtri SQL'i whitelist (`RETURN_METHOD_SQL`).

## Kirim (prixod) va tovar harakati (`src-tauri/src/stock.rs`, `lib/stock.ts`)

- Qoldiqni faqat 4 yo'l o'zgartiradi va har biri jurnal qoldiradi: sotuv (`sale_items`), vozvrat (`sale_return_items`), kirim (`stock_receipt_items`), qo'lda tuzatish (`stock_adjustments`). `products.stock` ga boshqa joydan YOZMA — "Davr harakati" (`stockMovementReport`) davr boshi/oxiridagi qoldiqni joriy qoldiqdan shu jurnallar bilan orqaga tiklaydi; jurnalsiz o'zgarish hisobotni buzadi.
- `saveProduct` qoldiqni yozmaydi (yangi mahsulot 0 bilan). Mahsulot formasi qoldiqni `adjustProductStock` orqali beradi: yangi → `initial`, tahrir → `manual`.
- Kirim/bekor qilish/tuzatish Rust'da, bitta `BEGIN IMMEDIATE` tranzaksiyada (vozvrat bilan bir xil sabab). DDL `STOCK_SCHEMA_SQL` — migratsiya v11 + `ensure_stock_schema` self-heal (eski bazalar v7/v8 da tiqilgan).
- Tannarx kirimda og'irlikli o'rtacha; eski tannarx 0 yoki qoldiq ≤ 0 bo'lsa — kirim narxi; kirim narxi 0 bo'lsa o'zgarmaydi. Sotuv narxi kirimda ixtiyoriy yangilanadi.
- Bekor qilish yozuvni o'chirmaydi (`voided_at`), qoldiqni ayiradi; tovar sotilib qoldiq yetmasa rad etiladi (`allow_negative_stock` yoqilmagan bo'lsa). Tannarx/narx faqat kirimdan keyin hech kim o'zgartirmagan bo'lsa eski holiga qaytadi.
- Bekor qilingan kirim hisobotda umuman yo'q. Bu versiyadan oldingi qo'lda o'zgarishlar jurnalda yo'q — ular "boshlang'ich" ga qo'shilgan.
- Testlar: `cargo test --lib stock`.

## Davr harakati / Mahsulot harakati (`pages/Movement.vue`, `pages/ProductMovement.vue`)

- Panda WMS'dagi bilan bir xil modullar (egasi so'ragan). Ma'lumot `lib/stock.ts`: `MOVES_SQL` — to'rt jurnal bitta ro'yxatda; `stockMovementReport` (Davr qatori), `productMoves` + `moveSummary` (kartochka). Kirim = kirim + vozvrat + tuzatish(+), chiqim = sotuv + tuzatish(−).
- Kartochka davr yig'indisi (4 karta) Davr harakati qatoriga AYNAN teng va filtrsiz; "Qoldiq" ustuni butun tarixdan, filtrga qaramaydi. Bir kun ichida avval kirim, keyin chiqim (o'tgan kunga yozilgan kirim soxta minus bermasin).
- Davr ikkala sahifa orasida `lib/rowCursor.ts storedRange` bilan bo'lishiladi; kartochka holati manzilda (`from,to,dir,party,q,sort,src`). Qator kursori ↑↓ PgUp/PgDn Esc Enter — `useRowCursor`. Hujjatni ochish: o'sha bo'lim `?q=<raqam>` bilan (Kirim/Sotuvlar/Vozvratlar/Mahsulotlar `?q=` ni o'qiydi).

## Excel eksport (`lib/xlsx.ts`, `lib/exports.ts`)

- Haqiqiy .xlsx (fflate zip + inline matn), CSV EMAS: rus/o'zbek Windows Excel CSV'ni ";" bilan kutadi. CSV ham bor (Panda kabi: BOM + ";"). Fayl Downloads'ga yoziladi va `openPath` bilan ochiladi (opener scope'da `$DOWNLOAD/**`).
- Eksportlar: Mahsulotlar (inventarizatsiya uchun "Sanaldi" + formulali "Farq"), Davr harakati va Mahsulot harakati (Excel + CSV; kartochkada tepada meta — mahsulot, davr, qoldiqlar, filtr). Kirim bo'limida Excel YO'Q (egasi: kerak emas).

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
- **Telefon tartibi (<1024px)** — `src/style.css` oxiridagi hook klasslar: `os-page` (butun sahifa `main` bilan aylanadi),
  `os-stats` (stat kartalar gorizontal lenta), `os-filters` + `os-search`/`os-more`/`os-filter-btn` (qo'shimcha filtrlar
  "Filtr" ortida, sahifada `filtersOpen`/`filtersActive`), `os-scroll`, `os-list` (guruhlangan karta). Yangi bo'lim sahifasi
  shu hooklar bilan yoziladi. Desktop oynasi `minWidth: 1024` — Mac/Windows ko'rinishiga ta'sir qilmaydi. Telefonda ro'yxat
  konteyneri aylanmaydi → bo'laklab chizish IntersectionObserver'ida `root: scrollRoot(el)` (`lib/scroll.ts`), qattiq ref EMAS.

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

## Telegram kassa — bulut versiyasi (`cloud/`)

OpenSales Kassa: shu sahifalar (src/pages) Telegram Mini App sifatida, to'liq Cloudflare'da
(Worker + har do'konga bitta SQLite Durable Object + D1 registry). Laravel backend'ga bog'liq EMAS.
Desktop o'z `pos.db` si bilan alohida ishlaydi; sxema bir xil (keyin import mumkin).

- **Bitta kod, ikki target.** `cloud/web/vite.config.ts` plugin'i desktop modullarini absolyut yo'l bo'yicha
  almashtiradi: `lib/{db,stock,reports,print,xlsx,platform,auth,i18n,theme}.ts` → `cloud/web/lib/*`,
  `@tauri-apps/api/core` → `cloud/web/shim/tauri-core.ts` (invoke → RPC, Rust buyruq nomlari bilan).
  Bundle'da `@tauri-apps/plugin-*` bo'lsa build yiqiladi. `cloud/web/parity.ts` — desktop lib'ga yangi
  funksiya qo'shsang bulut modulida ham yoz, aks holda `vue-tsc` yiqiladi.
- **Sahifalarda xom SQL YOZMA** (`db()` bulutda yo'q) — SQL faqat `lib/*.ts` funksiyalarida, bulutda
  shu nomdagi op `cloud/src/shop/ops/*.ts` da (sinxron, `transactionSync`, SQL desktopdagidek).
  Yangi lib funksiya = yangi op + `test/node/parity.test.ts` da solishtirish.
- **Rust mantiq o'zgarsa** (returns.rs, returns/customer.rs, stock.rs) — `cloud/src/shop/ops/{returns,returnsCustomer,stock}.ts`
  ga ham ko'chir; Rust testlari `cloud/test/node/{returns,stock}.test.ts` da bir xil holatlar bilan.
- **A'zolar:** taklif havolasi rol bilan — `cashier` yoki `owner` (boshqa Telegram akkauntni to'liq huquq bilan
  ulash; D1 `0002_invite_roles`). Asosiy ega = `tenants.owner_uid` (do'konni ochgan): faqat u `owner` taklifini
  yaratadi va ikkinchi egalarni yoqadi/o'chiradi; asosiy egani va o'zini hech kim o'chirmaydi; faol kassir `owner`
  havolasini ochsa — egaga ko'tariladi, ega taklif bilan pasaymaydi. Testlar: `test/worker/api.test.ts`.
- **Huquq:** kassir — `/pos`, `/sales` (o'ziniki), `/settings`. Server op'da `access: 'owner'|'cashier'`;
  rol tokendan emas, DO'dagi `members` nusxasidan (kassirni o'chirish darhol). UI: `can()`, `routeAllowed()`
  (desktop'da doim true).
- **Har yozuv idempotent:** klient `Idempotency-Key` yuboradi, natijasi noma'lum chaqiruv kaliti eslab qolinadi
  (javob yo'qolib qayta bosilsa ikkinchi chek chiqmaydi). Server: kalit+natija o'sha tranzaksiyada.
- **Ranglar Telegram mavzusidan** (2026-11-09, user talabi): `cloud/web/lib/theme.ts applyTelegramColors` —
  `themeParams` → tokenlar (sahifa = secondary_bg, karta = section_bg, tugma/`--glass-tint` = button_color,
  `--on-tint` = button_text_color, izoh = hint, ajratgich = section_separator), `themeChanged` da jonli. Tugma
  rangi ustidagi matn `#fff` EMAS — `var(--on-tint, #fff)`. Telegram tashqarisida (lokal dev) — quyidagi o'z palitramiz.
- **Liquid glass (telefon uslubi)** faqat `cloud/web/style.css` da, tokenlar orqali (desktop ranglari o'zgarmaydi):
  zaxira palitra oq-qora, fon sovuq kulrang + neytral porlash, kartalar shaffof oq + yorug' chet + soya — kartalarda
  `backdrop-filter` YO'Q (zaif Android). Haqiqiy blur faqat suzuvchi qatlamlarda: `.page-header`, `.tg-tabbar`, `.tg-sheet`.
  `fixed`/`sticky` ichidagi `bg-card` qattiq (`--popover`) — shaffof modal ostidan matn ko'rinadi. Pastki panel —
  suzuvchi kapsula + siljiydigan linza (`App.vue` `activeTab`).
- **Shisha maydonlar:** bulut build'ida sahifalardagi native `<select>` → `GlassSelect`, `<input type="date">` →
  `GlassDate` (`vite.config.ts` → `cloudFields`, kompilyatsiyadan oldin matn almashtirish; global komponentlar `main.ts`),
  `SearchableSelect` → `cloud/web/components/SearchableSelect.vue` (SWAP). Sahifada select/date odatdagidek yoziladi
  (`v-model` + `<option>`); `<select>` atributida `>` belgisi bo'lmasin (regex). Hamma tugma shisha — `style.css` "tugmalar".
- **Sahifa keshi (KeepAlive, `App.vue`):** qayta kirish yuklanishsiz. Yangidan yuklanadi faqat kirilgandan beri yozuv bo'lsa
  (`freshness.ts dataVersion`, `rpc.call` write → `bumpData`), push+query bilan ochilsa yoki AI shu sahifada saqlasa. Global
  `window` tinglovchili sahifa/composable `onActivated`/`onDeactivated` juftini qo'shsin (Pos/Products skaneri, rowCursor) —
  aks holda yashirin sahifa klaviaturani tutadi. Pos: "Savatni eslab qolish" o'chiq bo'lsa `onDeactivated` savatni tozalaydi.
- **Telefon ro'yxatlari:** `.os-list` ichida `truncate`/`line-clamp-1` o'raladi (to'liq matn), summalar `nowrap`.
- **Silliqlik (harakat):** sahifa — `App.vue` RouterView o'rami `.page-anim` (tab: fade, ichkariga/orqaga: yon
  sirpanish; yo'nalish va scroll xotirasi `nav.ts`). View Transitions ATAYIN yo'q (bosishni ushlaydi, iOS 17'da yo'q).
  Modallar build'da `<Transition name="os-modal">` ga o'raladi (`cloudTemplates`: `v-if` + statik `fixed inset-0`
  yoki `MODAL_TAGS`) — yangi modal komponent qo'shsang ro'yxatga yoz. Faqat opacity/transform; `backwards` fill
  (tugagach transform qolsa fixed elementlar sahifaga yopishadi). Telefonda ro'yxat VA jadval birga chizilmaydi
  (`lib/useWide.ts`, `v-if`), katta ro'yxat bo'laklab (Mahsulotlar 30, Davr harakati 40). O'lchov: CPU 4x'da
  almashish/modal/varaq kadri ≤50 ms.
- **Modal ✕ va orqaga:** bulut build'i har modal kartasiga o'ng yuqorida ✕ qo'shadi (`modalCloseInserts`) — u
  modalning "Bekor qilish" (bo'lmasa "Yopish") tugmasining `@click` ifodasini chaqiradi; shuning uchun yangi modalda
  bekor tugmasi `$t('common.cancel')` matni va oddiy `@click` bilan bo'lsin. Ichki sahifalarda (`/x/:id`) "orqaga" —
  `App.vue` dagi suzuvchi shisha `.tg-back` (chap yuqorida); sahifaning o'z orqaga tugmasiga `os-back` qo'y (bulutda yashirin).
- **Rasm qo'shish (telefon):** `src/components/PhotoPicker.vue` (Kamera/Galereya plitkalari) + `PhotoCamera.vue`
  (ilova ichidagi jonli kamera; iOS'da `<input capture>`). Products formasida `lg:hidden`, desktop blok o'zgarmagan.
- **AI yordamchisi (matn/ovoz → amal):** asosiy — **Gemini** (`GEMINI_API_KEY` secret, `GEMINI_MODEL` var = `gemini-3.5-flash`;
  ovoz + tahlil bitta so'rovda, o'zbekchani Whisper'dan ancha yaxshi taniydi; OGG/WebM/m4a qabul qiladi). Xato/timeout (20 s)
  bo'lsa — zaxira Workers AI (`AI` binding: `whisper-large-v3-turbo` + `llama-3.3-70b`). 2026-11-08 o'lchov: 3.5-flash 1,7–2,5 s;
  3.8-flash va flash-latest 30 s javobsiz; 2.5-flash yangi kalitlarga yopiq; Gemini 3 da `thinkingLevel`, 2.5 da `thinkingBudget`.
  Tekshirish: `POST /tg/ai-check` (X-Setup-Key; body `{model?, list?, audio?, mime?}`). Kontekst: oxirgi 20 daq/6 xabar
  (`historyTurns`, holatlar: open/saved/cancelled/replaced) — "yuqoridagilar" tushuniladi. **Tuzatish** ("16 emas, 18 dedim"):
  model `revises: true` + o'sha so'rovning TO'LIQ nusxasini beradi → `createDraft` shu turdagi oxirgi ochiq qoralamani
  `cancelled` + `replacedBy` qiladi, bot eski kartani tugmalarsiz "↪️ Yangilandi" deb tahrirlaydi (`markReplaced`, karta id
  `assistantSetCard`). Promptda: model nomlarini "tanish" modelga to'g'rilama (iPhone 18 → 16 bo'lardi).
  Narx boshqa valyutada aytilsa — `currencyMismatch` (tuzatilmaguncha blok). Kurs: `assistant/fx.ts` — do'konning oxirgi
  kursi (`settings.fx_USD_UZS`) yoki MB kursi (cbu.uz, faqat so'm do'kon); bot kartasida "💱 1 $ = … · MB kursi" va
  "✅ so'mga o'tkazib saqlash" (`r:<id>:<kurs>`); ilovada ham shu server konvertatsiyasi (`edits.rate`). Faqat AYTILGAN
  narxlar o'tkaziladi (`DraftItem.said`), katalog narxi tegilmaydi; nomni tuzatish ogohlantirishni o'chirmaydi (`moneySig`).
  **Yangi mijoz:** sotuv/to'lovda aytilgan mijoz bazada yo'q va o'xshashi ham yo'q (faqat ega) — `Draft.newCustomer`;
  `applyDraft` avval `saveCustomer` (`ai_<id>_c` kaliti, shu nomli bo'lsa — o'sha), keyin asosiy op. O'xshashi bo'lsa —
  tanlash yoki ilovada "yangi sifatida qo'shish". "Mijoz qo'sh + pul oldim" = to'lov (prompt), saldo EMAS.
  **Aytilgan kurs** ("dollar 12 mingdan"): `Extraction.rate` → `createDraft` darhol `applyEdits({rate})` (model o'zi
  hisoblamaydi); faqat kurs aytilgan xabar — `revises` + `rate` (ochiq qoralama o'tkaziladi).
  **Kvota:** Gemini bepul tarifi ~20 so'rov/kun/model — 429 bo'lsa `GEMINI_FALLBACK_MODEL` (standart `gemini-3.5-flash-lite`),
  keyin Workers AI. Prod uchun Google AI Studio'da billing kerak.
  Amallar: sotuv, mijoz to'lovi, xarajat, kirim, YANGI TOVAR (`assistant_create_products` op, bitta tx + 'initial' jurnal),
  YANGI MIJOZ + boshlang'ich saldo (`assistant_create_customers`: qarzi bor → manfiy, haqi bor → musbat, `setCustomerBalance`; ism bor bo'lsa blok).
  AI HECH NARSA YOZMAYDI: `assistant/ai.ts` faqat matnli `Extraction` beradi → `shop/assistant.ts` bazaga moslaydi
  (`assistant/match.ts`), qoralama (`assistant_drafts`, DO V2) → foydalanuvchi ko'radi/tuzatadi → `applyDraft` oddiy op'ni
  (`createSale`, `recordCustomerPayment`, `saveExpense`, `create_stock_receipt`) `ai_<draftId>` kaliti bilan chaqiradi.
  Tovar nomidagi raqamli belgi (25W, #12) foydalanuvchi so'zlarida bo'lmasa — tanlov asoslanmagan, variantlar ko'rsatiladi.
  **Mijozga qarz berish** (`payment_out`, 2026-11-12: "Anvarga 500 ming qarz berdim") — `recordCustomerPayout` op:
  `customer_payments` da MANFIY summa (balans kamayadi, harakat/saldo invarianti o'zgarmaydi; yo'l-yo'lakayga rad).
  "X dan qarz oldim" = `payment_in` (biz unga qarzmiz). Manfiy to'lov o'quvchilari: `CustomerShow` (`loan` qatori,
  "To'langan" jamiga kirmaydi), `answers.ts` (kassa: alohida "qarz berildi" qatori; oxirgi to'lov — faqat musbat).
  **Bir xabarda bir nechta amal:** model birinchisini asosiy maydonlarda, qolganini `also` da beradi (≤8, tuzatishda
  bo'sh) → `ShopDO.assistantDraft` har biriga qoralama (`partOf` = birinchisining id'si, bitta tx) → botda har biriga
  alohida karta (o'sha xabarga reply, transkript faqat birinchisida), ilova chatida `more` (foydalanuvchi pufagi
  `user: null`). Kontekstda (`historyTurns`) xabar bir marta, xulosalar bitta javobda.
  Kassir faqat sotuv; xarajat ≠ qarz berish. Kanallar: mini app (✨ tugma,
  `components/Assistant.vue`, MediaRecorder; mikrofon oqimi `web/mic.ts` da BITTA marta olinadi va qayta ishlatiladi —
  Telegram Android har `getUserMedia` da ruxsat oynasini chiqaradi; varaq yopilgach 60 s / fonga o'tsa darhol bo'shatiladi;
  "Botga ovoz yuborish" = `goToBotChat` — havola + ilovani yopish, chunki ilova shu chat ustida ochiq bo'ladi;
  `web/public/_headers` da `Permissions-Policy: microphone=(self)` SHART — `()` bo'lsa Telegram "Ruxsat"dan keyin ham
  WebView rad etadi, oyna har bosishda chiqadi; `test/node/headers.test.ts` qulflaydi) va bot chati (ovoz/matn → karta ✅/❌, `telegram/assistantBot.ts`).
  Kunlik limit `AI_DAILY_LIMIT` (do'kon boshiga). Testlar soxta AI bilan (`test/node/assistant.test.ts`,
  `test/worker/assistant.test.ts`); lokal `wrangler dev` haqiqiy AI'ni chaqiradi (pul, kunlik bepul limit ichida).
  Deploy: `setWebhook` da `allowed_updates: ["message","callback_query"]` SHART (aks holda ✅ tugmasi ishlamaydi).
- **R2 ishlatilmaydi** — rasm DO'da BLOB (≤300KB, magic bytes), `/img/<tid>/<pid>/<ver>` immutable.
- Chek printer o'rniga ULASHILADI: `/api/receipt` → `savePreparedInlineMessage` (HTML karta, `telegram/receiptCard.ts`,
  hamma satr escape) → ilova `shareMessage(id)` (chat tanlash; xodimning o'ziga YUBORILMAYDI); Bot API < 8.0 — `t.me/share`.
  RASM + MATN: ilova chekni `src/lib/receiptCanvas.ts drawReceipt` (desktop termal PNG bilan bitta chizish) bilan JPEG qiladi →
  DO `receipt_images` (V4, 2 kun) → `/rimg/<tid>/<id32>.jpg` → `InlineQueryResultPhoto`, izoh ≤1024 (`cardHtml(card, 1000)`).
  Worker yo'li `wrangler.jsonc run_worker_first` da BO'LISHI SHART — aks holda SPA `index.html` (200 text/html) qaytadi:
  2026-11-09 `/rimg/*` yo'q edi → chek rasmsiz, xabar yuborilmadi (qizil «!»). `test/node/headers.test.ts` route() prefikslarini tekshiradi.
  Chekda mijoz saldosi: `balance_before`/`balance_after` (Pos sotuvdan OLDIN oladi; uchala desktop renderer + bulut matni).
- **Yordamchi chatlari (ilova, to'liq ekran):** chat = shu chatdagi qoralamalar (`assistant_chats` + `assistant_drafts.chat_id/voice`,
  DO V3); kontekst (`historyTurns(..., chatId)`) va tuzatish (`revises`) chat ichida, vaqt cheklovisiz; chat egasidan boshqasi
  ko'rmaydi. Chatdagi qoralamalar 7 kunda o'chmaydi (chat 90 kun faolsiz bo'lsa — birga). Karta = botdagi HTML
  (`draftCardHtml`), tugmalar ✅/❌/✏️ (`/api/assistant/{chats,chat,chat-delete}`, parse `chatId`/`X-Chat-Id`). Bot — o'zgarmagan.
  Excel — xodimning chatiga (`/api/export` → sendDocument).
- **Hisobot savollari** ("umumiy qarz qancha?", "bugun qancha sotdik?", "kassada qancha bor?", "AirPods qancha qoldi?"):
  model faqat mavzu+davrni beradi (`action: "report"`, `report` ∈ debts/customer/sales/cash/stock/expenses/top_products,
  `period`) → `sanitize` uni `unknown` + `report` qiladi → `createDraft` javob matnini `shop/answers.ts answerReport` bilan
  BAZADAN hisoblaydi (`question` ga), model raqam yozmaydi. Formulalar Hisobot (`reportSummary`, UTC kun) va Smena
  (`shiftStats`) bilan bir xil. Kassir: faqat o'z savdosi, o'z smenasi, bitta tovar qoldig'i; qolgani "faqat ega".
  Tovar nomida aytilmagan raqamli belgi (#121, 25W) bo'lsa — variantlar (qoralamadagi kabi). Javob tili: savol tili, aks holda ilova tili.
- **Javob tili va salom:** `ShopHints.lang` (ilova/bot tili) — qisqa/noaniq xabar ("Sava") shu tilda (fransuzcha javob
  bo'lgan edi); o'zbek slengi ro'yxati promptda. `ShopHints.greeted` (`assistantBegin`: shu chatda, bot — shu odam bilan,
  oxirgi 12 soatda xabar bor) → "do NOT greet again". Imkoniyatlar ro'yxati faqat birinchi xabarda yoki so'ralsa.
- **Chat UI:** yozish paneli suzuvchi (`.ai-float`, absolute; chat `padding-bottom` = panel balandligi, ResizeObserver).
  Chat ochilishi darhol OXIRIDA (`watch(chatEl, flush:'post')` + `toEnd(false)`; xotirada `chatCache`, birinchi marta
  yuklanguncha `.loading` yashirin) — silliq aylanish faqat yangi xabarda.
- **Fondan qaytish (Android WebView):** GPU qatlamlari qayta chizilmay qora ekran + yopiq savat bo'lagi ko'rinardi.
  `telegram.ts repaintOnResume` (visibilitychange/pageshow/focus/`activated`) bir necha kadr `.os-repaint body{opacity:.999}`;
  Telegram tizim oynasidan keyin ham (`shareMessage` callback, `shareMessageSent/Failed`, `popupClosed`, `scanQrPopupClosed`) —
  `repaintAfterOverlay()` (darhol + 400 ms).
- **Bir nechta do'kon (2026-11-09):** D1 `0004` — `tenants.group_id` (biznes ildizi), `catalog_of` (filial), `members` PK
  `(uid, tenant_id)`, `user_prefs.active_tenant`; `findMember` YO'Q → `findMembership/listMemberships/defaultMembership`.
  Obuna guruh bo'ylab (`setPaidUntil/setTenantStatus` → `syncSubscriptions`), yangi do'konga sinov YO'Q, ≤10 do'kon.
  `/api/session/switch`, `/api/shops/create` (alohida + `copyFrom` nusxa / filial `catalogOf`), bot `/dokon`.
  **Filial katalogi:** DO V5 trigger'lar (`catalog_ver`, `sync_ver`, `catalog_tombstones`) → `src/catalog.ts syncCatalog`
  (kursor CAS); asosiyda `CATALOG_FANOUT_OPS` dan keyin fan-out, filial sessiyasida tortish; filialda katalog op'lari
  `assertCatalogWritable` 403, rasm asosiydan. UI: `can('catalogEdit')`. **Ko'chirish:** `shop/transfers.ts` (plan → out
  pending → in kirim `transfer_id` → done; alarm qayta yuboradi). **Umumiy hisobot:** `businessSummary` + `/api/group/report`.
  Testlar `test/worker/multishop.test.ts`. D1 migratsiyada ota jadvalni qayta qurish: bolalar `tenants_new`ga ishora qilsin.
- **Telegram to'liq ekran (Main App):** chekkalar `--safe-top/--chrome-top/--safe-bottom` (style.css; SDK
  `--tg-safe-area-inset-*` + `--tg-content-safe-area-inset-*`, Android'da env() = 0); `.app-shell` tepadan joy beradi,
  umumiy sahifalar `var(--page-safe-*,env(...))` (desktop'da env). Bulut CSS'da xom env() TAQIQ — `headers.test.ts`.
- **`--app-h` = haqiqiy WebView balandligi** (`web/viewport.ts appHeight`, `telegram.ts syncAppHeight`): Telegram
  `viewportStableHeight` share oynasidan keyin ~60px da QOTIB qoldi → ilova sarlavhada kesildi (Sotuvlar «qora»). Telegram
  qiymati faqat matn maydoni fokusda va ≥35% bo'lsa (iOS klaviatura). `test/node/viewport.test.ts`.
  telefonda yopiq `.os-cart` (`translate-y-full`) `visibility:hidden` (transition-property'da `translate` ham bo'lsin —
  Tailwind v4 `translate` xossasini ishlatadi).
- **Bot profili kodda:** `telegram/profile.ts` (description/about uz+ru) — `POST /tg/setup`; logo faqat `{"photo":true}` bilan
  (`web/public/bot-logo.jpg`, OQ-QORA brend — indigo EMAS). Admin buyruqlari menyusi faqat admin chatida (test qulflaydi).
- **Telegram widget kartalari (Bot API 10.4, 2026-11-11):** `sendWidget` — xabar ichida jonli HTML karta (QuickJS sandbox,
  tarmoq YO'Q; HTML ≤32KB va zlib9 ≤4096, chat_data ≤1024 — `test/node/{funnelCard,salesCard}.test.ts` qulflaydi). Prod'da
  FAQAT bot bilan shaxsiy chat (guruh/forward/inline — test server); `copyMessage` widget'ni nusxalamaydi. Karta tugmasi →
  `widget_query` (data ≤64 bayt, faqat tap ichida sinxron) → avval `answerWidgetQuery` (15 s), keyin hisob →
  `editMessageWidgetData` → karta `chatDataChanged` bilan qayta chiziladi. `setWebhook allowed_updates` da `widget_query` SHART.
  So'rov boshi: `d:` admin `/varonka` (`telegram/funnelWidget.ts`), `r:<do'kon>:<t|y|w|m>` egaga `/hisobot`
  (`telegram/salesWidget.ts`, raqamlar `ShopDO.salesCard` → `businessSummary`/`reportSummary`, faqat ega), `y…` bot
  yordamchisining TASDIQLASH KARTASI (2026-11-12, `telegram/draftWidget.ts` + `assistantBot.ts handleDraftQuery`): xabarning
  hamma amallari bitta widget'da (guruh = birinchi qoralama id, `shop/assistant.ts groupDrafts/applyGroup/cancelGroup`).
  Widget'da input/klaviatura YO'Q (faqat tugma) — tahrir: qatorni bosish → usul/mijoz/tovar chiplari, ichki raqam paneli
  (summa, narx, miqdor, hozir to'langan), ✕; so'rov `y<op>:<id>[:arg]` → `widgetEdit` → `applyEdits` (yangi `item`/`person`
  — bitta qator) → `editMessageWidgetData` + `editMessageCaption` (tugmalar bilan). ✅/❌ widget OSTIDA (`A:`/`X:` + guruh) —
  widget'siz eski ilovada ham ishlaydi; `applyGroup` biror qator tayyor bo'lmasa hech narsa yozmaydi. sendWidget yiqilsa —
  eski matnli kartalar (`a:`/`x:`/`r:`). Ilovada tuzatilgan/saqlangan qoralama botdagi kartani yangilaydi (`syncDraftCard`).
  Cheklov: foydalanuvchi 5 so'rov/5 s, balandlik ≤600 px (ko'p qator + ochiq panel kesilishi mumkin), ru HTML zlib ~3,8 KB / 4 KB.
  Caption = widget'siz ilova uchun matn. Nomlar faqat `textContent`. Sinov: brauzerda `window.TelegramWidget` stub + `--tg-theme-*`.
- **AI'ni do'kon uchun o'chirish (admin):** D1 `tenants.ai_enabled` (0003) + DO meta `ai_enabled`; `assistantBegin` 403
  `cloud.ai.errors.disabled` (kvota sarflanmaydi); sessiyada `ai` → ✨ yashirin.
- Obuna: ro'yxatdan o'tishda 7 kun sinov (`TRIAL_DAYS`, 2026-11-09 gacha 30 edi — eski do'konlar o'zgarmagan); admin chatidan (`ADMIN_CHAT_ID`) `/tenants`, `/extend <id> YYYY-MM-DD`
  (Toshkent kuni oxirigacha), `/block`, `/unblock`. Tugagan bo'lsa yozish 402, o'qish ochiq.
  Ilovada **Admin** bo'limi (`/admin`, `pages/Admin.vue`, API `/api/admin/{tenants,extend,status}`) — faqat uid
  `ADMIN_CHAT_ID` da bo'lsa (sessiyada `admin: true`, "Ko'proq"da plitka); bot'da `/admin` → ilova tugmasi; admin
  buyruqlari menyusi `/tg/setup` da chat scope bilan. Admin o'z do'konini bloklay olmaydi.
- **Pastki panel bo'shlig'i** sahifa ichida (`.page-anim > :not(.fixed)` padding), `main`da EMAS: o'sadigan sahifa
  (`os-page`, `min-h-full`) `h-full` o'ramdan oshadi va main padding'i kontent tagiga tushmaydi.
- **Bot kartasidan ochish** (`?draft=`): App router query'sidan o'qiydi; `Assistant.vue` `onMounted`da ham tekshiradi
  (App `open`ni komponentdan oldin yoqadi). Oxirgi sahifa (`kassa:last_route`) bir martalik `draft`siz saqlanadi.
  Bir xabarda bir nechta amal (guruh, `partOf`) — `/api/assistant/group` (istalgan amal id'si → butun guruh) ilovada
  BITTA karta bo'lib ochiladi (har amal qator: ✏️/❌; ostida "Hammasini tasdiqlash"/"Bekor" → `group-apply`/`group-cancel`,
  botdagi A:/X: bilan bir xil: tayyor bo'lmagan amal bo'lsa hech biri yozilmaydi). Ilova chatida ham ketma-ket
  `user`siz kartalar shu bitta kartaga yig'iladi (`blocks`). Bitta amal — to'g'ridan tahrirga. Kartadagi amal tahriri (`editCtx`): sarlavha
  "Tahrirlash · N ta amaldan i-chisi", butun xabar matni YO'Q, "Jami" faqat tovarli amalda; «✓ Saqlash» = avto-sinxron
  tuzatishlar + kartaga qaytish (YOZMAYDI), «Olib tashlash» = shu amalni bekor. Maydonlar `--accent` fonda (avval
  `--background` edi — sahifa foniga qo'shilib ko'rinmasdi).
- Testlar: `cd cloud && npm test` (node: op'lar + desktop paritet + Rust holatlari; worker: miniflare'da auth,
  RPC, izolyatsiya, taklif, rasm, webhook). Lokal: `.dev.vars` (soxta BOT_TOKEN) + `npx wrangler d1 migrations apply pos-registry --local`,
  launch.json'dagi `kassa-worker` (8790) + `kassa-web` (5190); brauzerda `/?dev_uid=<id>` — dev shim initData'ni
  imzolaydi (faqat Vite dev, prod'da yo'q).
- **Prod (2026-11-08 deploy):** asosiy manzil **https://posbot.opensales.uz** (2026-11-09 dan; Cloudflare custom domain,
  `wrangler.jsonc routes` + `APP_URL`), eski https://opensales-kassa.abdullayevilxomjon1.workers.dev ham ishlaydi; bot @OpenSalesPOSBot,
  D1 `pos-registry` (EEUR, id `wrangler.jsonc` da), Cloudflare akkaunti abdullayevilxomjon1@gmail.com.
  Secretlar: `SESSION_KEY`, `TG_WEBHOOK_SECRET` (lokal nusxa `cloud/.prod-secrets`, gitignored, chmod 600), `BOT_TOKEN`
  (user o'zi `wrangler secret put` — token chatga tushmaydi). Bot sozlash: `POST /tg/setup` + `X-Setup-Key: <TG_WEBHOOK_SECRET>`
  — webhook (`message`+`callback_query`), menyu tugmasi, /start. Deploy: `npm test` YASHIL bo'lgach `npm run deploy`;
  D1 migratsiya: `npx wrangler d1 migrations apply pos-registry --remote`. `ADMIN_CHAT_ID` hali bo'sh.
- **Lokal D1 tuzog'i:** lokal `wrangler dev` D1 faylini `database_id` bo'yicha tanlaydi (`preview_database_id` yordam
  bermaydi). ID o'zgarsa lokal baza "bo'sh" ko'rinadi — eski `.wrangler/state/v3/d1/...sqlite` ni yangi nomga ko'chirish kerak.
