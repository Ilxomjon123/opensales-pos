-- Taklifda rol: kassir yoki egasi. "Egasi" taklifi — boshqa Telegram akkauntni (sherik yoki
-- egasining ikkinchi akkaunti) do'konga to'liq huquq bilan ulash. SQLite CHECK'ni o'zgartirib
-- bo'lmaydi — jadval qayta yaratiladi (ma'lumot ko'chiriladi).

CREATE TABLE invites_v2 (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL DEFAULT 'cashier' CHECK (role IN ('cashier', 'owner')),
  created_by INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_by INTEGER,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO invites_v2 (token_hash, tenant_id, role, created_by, expires_at, used_by, used_at, revoked_at, created_at)
  SELECT token_hash, tenant_id, role, created_by, expires_at, used_by, used_at, revoked_at, created_at FROM invites;
DROP TABLE invites;
ALTER TABLE invites_v2 RENAME TO invites;
CREATE INDEX idx_invites_tenant ON invites(tenant_id);
