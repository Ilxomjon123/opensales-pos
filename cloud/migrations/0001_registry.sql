-- Registry: kim qaysi do'konga tegishli va obuna holati. Do'kon ma'lumoti (tovar, sotuv)
-- bu yerda EMAS — har do'konning o'z Durable Object SQLite bazasida.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,                       -- tasodifiy; DO nomi va rasm manzilida
  name TEXT NOT NULL,
  owner_uid INTEGER NOT NULL UNIQUE,         -- Telegram user id (bitta egada bitta do'kon)
  trial_until TEXT NOT NULL,                 -- ISO; ro'yxatdan o'tishda +30 kun
  paid_until TEXT,                           -- ISO; admin /extend bilan
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  uid INTEGER PRIMARY KEY,                   -- Telegram user id; v1: bitta odam — bitta do'kon
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'cashier')),
  name TEXT NOT NULL,
  username TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_members_tenant ON members(tenant_id);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,               -- SHA-256(token) hex; token o'zi saqlanmaydi
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL DEFAULT 'cashier' CHECK (role IN ('cashier')),
  created_by INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_by INTEGER,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invites_tenant ON invites(tenant_id);
