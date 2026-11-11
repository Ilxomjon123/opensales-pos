-- Varonka (2026-11-10): reklama → bot/ilova → do'kon → tovar → sotuv → 2-kun.
--  * funnel_users: har foydalanuvchi uchun BITTA qator; har bosqich — unga birinchi yetgan vaqt (keyin o'zgarmaydi).
--    src — birinchi manba (bot /start parametri yoki ilova startapp, masalan `ig_reel`). Tovar/sotuv bosqichlari
--    do'kon DO'sidan cron (har 15 daqiqa) va admin paneli orqali yangilanadi — sotuv yo'liga hech narsa qo'shilmaydi.
--  * nudges: avtomatik bot eslatmalari — (uid, kind) bo'yicha ko'pi bilan BITTA (yuborishdan OLDIN yoziladi).
--  * platform_settings: admin panelidagi sozlamalar (masalan, eslatmalar yoqilganmi).

CREATE TABLE funnel_users (
  uid INTEGER PRIMARY KEY,                   -- Telegram user id
  name TEXT,
  username TEXT,
  lang TEXT,
  src TEXT,                                  -- birinchi manba
  started_at TEXT,                           -- botda /start (taklifsiz)
  opened_at TEXT,                            -- ilova birinchi ochildi
  shop_id TEXT,                              -- birinchi (ildiz) do'kon
  shop_at TEXT,
  products INTEGER NOT NULL DEFAULT 0,       -- oxirgi tekshiruvdagi faol tovarlar soni
  sales INTEGER NOT NULL DEFAULT 0,          -- oxirgi tekshiruvdagi sotuvlar soni
  product_at TEXT,                           -- birinchi tovar ko'rilgan vaqt
  sale_at TEXT,                              -- birinchi sotuv vaqti
  day2_at TEXT,                              -- birinchi sotuvdan keyingi BOSHQA kundagi sotuv (qaytib keldi)
  last_sale_at TEXT,
  checked_at TEXT,                           -- DO'dan oxirgi yangilangan vaqt
  created_at TEXT NOT NULL
);
CREATE INDEX funnel_users_shop ON funnel_users(shop_id);
CREATE INDEX funnel_users_created ON funnel_users(created_at);

CREATE TABLE nudges (
  uid INTEGER NOT NULL,
  kind TEXT NOT NULL,                        -- no_shop | no_product | no_sale | trial_end
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  at TEXT NOT NULL,
  PRIMARY KEY (uid, kind)
);

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Mavjud egalar (ildiz do'konlar) — "do'kon ochdi" bosqichidan. Ularga avtomatik eslatma YUBORILMAYDI
-- (no_shop/no_product/no_sale — admin o'zi yozadi); sinov tugashi eslatmasi ochiq qoladi.
INSERT INTO funnel_users (uid, name, username, shop_id, shop_at, created_at)
  SELECT t.owner_uid, m.name, m.username, t.id, t.created_at, t.created_at
  FROM tenants t LEFT JOIN members m ON m.uid = t.owner_uid AND m.tenant_id = t.id
  WHERE t.id = t.group_id;
INSERT INTO nudges (uid, kind, status, at)
  SELECT f.uid, k.kind, 'skipped', f.created_at
  FROM funnel_users f, (SELECT 'no_shop' AS kind UNION ALL SELECT 'no_product' UNION ALL SELECT 'no_sale') k;
