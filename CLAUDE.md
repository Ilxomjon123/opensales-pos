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

## Litsenziya (Ed25519, offline)

- Dasturda FAQAT public kalit (`src/lib/license.ts`). Private seed faqat egasida, hech qachon build ichiga joylanmaydi.
- 1-marta o'rnatishda avtomatik 15 kun sinov. Muddat tugasa → `/activate` ekrani bloklaydi.
- Kalit har PC ga bog'liq (`device_id`). Deterministik: bir xil (deviceId + exp + seed) = bir xil kalit.
- Generator: aktivatsiya ekranida logoga 5 marta bos YOKI Sozlamalar→Litsenziya kalit ikonkasini 5 marta bos → master (`VITE_OWNER_MASTER`) → seed + muddat → kalit.
- Bekor qilish: generatordagi qizil tugma → `license_revoked=1` → dastur aktivatsiyani kutadi.
- Maxfiy qiymatlar `.env`da (`VITE_*`), DB'da emas: `VITE_OWNER_MASTER`, `VITE_RECOVERY_MASTER`, `VITE_DEFAULT_PIN`. Private seed kodda yo'q — parol menejerda.

## UI

- Bo'lim layout standarti (Mahsulotlar/Mijozlar/Smenalar/Kategoriyalar/Sotuvlar): header + stat kartalar (bosilsa filter) + filter bar + sticky `bg-muted` thead + tfoot "Jami". Cyrillic/Latin farqsiz `translitMatch`.
- Tauri WKWebViewda `window.confirm/alert/print` ishlamaydi → `lib/confirm.ts`, `lib/notify.ts`, `lib/print.ts` (HTML→AppCache→opener).
- Modal tashqarisi bosilganda yopilmasin (faqat tugma). Action tugmalar doim ko'rinsin (hover emas).
