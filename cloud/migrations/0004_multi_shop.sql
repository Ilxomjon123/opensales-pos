-- Bir egada bir nechta do'kon (2026-11-09).
--  * tenants.owner_uid endi UNIKAL EMAS; do'konlar guruhi (biznes) = group_id (ildiz — birinchi do'kon id'si).
--    Bir odamning faqat BITTA ildizi bo'ladi (qisman unikal indeks) — onboarding ikki marta bosilsa ikki biznes ochilmaydi.
--  * catalog_of: filial — katalog shu (asosiy) do'kondan sinxronlanadi; NULL — alohida do'kon.
--  * members: bir odam bir nechta do'konda (PK uid + tenant_id).
--  * user_prefs: oxirgi tanlangan do'kon (kirish va bot yordamchisi uchun standart).
-- SQLite UNIQUE/PK'ni o'zgartirib bo'lmaydi — jadvallar qayta quriladi. FK yoqiq holatda ota jadvalni
-- (tenants) unga ishora qiluvchi qatorlar bilan o'chirib bo'lmaydi (commit'da yiqiladi). Shuning uchun yangi
-- bolalar `tenants_new`ga ishora qiladi, eski bolalar avval o'chiriladi; `tenants_new → tenants` nomi
-- almashganda SQLite bolalardagi havolani o'zi yangilaydi.

PRAGMA defer_foreign_keys = true;

CREATE TABLE tenants_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_uid INTEGER NOT NULL,                -- do'konni ochgan (asosiy ega)
  group_id TEXT NOT NULL,                    -- biznes ildizi (birinchi do'kon id'si; ildizda = id)
  catalog_of TEXT,                           -- filial: katalog manbai (shu guruhdagi alohida do'kon)
  trial_until TEXT NOT NULL,                 -- obuna guruh bo'ylab bir xil yoziladi
  paid_until TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at TEXT NOT NULL,
  ai_enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO tenants_new (id, name, owner_uid, group_id, catalog_of, trial_until, paid_until, status, created_at, ai_enabled)
  SELECT id, name, owner_uid, id, NULL, trial_until, paid_until, status, created_at, ai_enabled FROM tenants;

CREATE TABLE members_new (
  uid INTEGER NOT NULL,                      -- Telegram user id
  tenant_id TEXT NOT NULL REFERENCES tenants_new(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'cashier')),
  name TEXT NOT NULL,
  username TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (uid, tenant_id)
);
INSERT INTO members_new (uid, tenant_id, role, name, username, active, created_at)
  SELECT uid, tenant_id, role, name, username, active, created_at FROM members;

CREATE TABLE invites_new (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants_new(id),
  role TEXT NOT NULL DEFAULT 'cashier' CHECK (role IN ('cashier', 'owner')),
  created_by INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_by INTEGER,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO invites_new (token_hash, tenant_id, role, created_by, expires_at, used_by, used_at, revoked_at, created_at)
  SELECT token_hash, tenant_id, role, created_by, expires_at, used_by, used_at, revoked_at, created_at FROM invites;

DROP TABLE members;
DROP TABLE invites;
DROP TABLE tenants;
ALTER TABLE tenants_new RENAME TO tenants;
ALTER TABLE members_new RENAME TO members;
ALTER TABLE invites_new RENAME TO invites;

CREATE INDEX idx_tenants_owner ON tenants(owner_uid);
CREATE INDEX idx_tenants_group ON tenants(group_id);
CREATE UNIQUE INDEX idx_tenants_root_owner ON tenants(owner_uid) WHERE id = group_id;
CREATE UNIQUE INDEX idx_tenants_group_name ON tenants(group_id, lower(name));
CREATE INDEX idx_members_tenant ON members(tenant_id);
CREATE INDEX idx_invites_tenant ON invites(tenant_id);

CREATE TABLE user_prefs (
  uid INTEGER PRIMARY KEY,
  active_tenant TEXT,
  updated_at TEXT NOT NULL
);
