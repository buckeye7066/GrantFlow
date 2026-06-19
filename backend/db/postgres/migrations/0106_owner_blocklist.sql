-- 0106_owner_blocklist.sql  (Postgres variant of sqlite 109_owner_blocklist)
--
-- See backend/db/migrations/109_owner_blocklist.sql for the full rationale.
-- Postgres is strict (migrate.js never swallows errors here), so every
-- statement is independently idempotent: IF NOT EXISTS on tables, indexes, and
-- ADD COLUMN. TEXT status/enforcement (not BOOLEAN) avoids the boolean=integer
-- shim entirely.

CREATE TABLE IF NOT EXISTS owner_blocklist (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  match_type TEXT NOT NULL,
  match_value TEXT NOT NULL,
  match_value_raw TEXT,
  reason TEXT,
  source TEXT,
  enforcement TEXT NOT NULL DEFAULT 'block',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  added_by_user_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_blocklist_type_value ON owner_blocklist(match_type, match_value);
CREATE INDEX IF NOT EXISTS idx_owner_blocklist_type ON owner_blocklist(match_type);

CREATE TABLE IF NOT EXISTS owner_blocklist_hits (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  blocklist_id TEXT,
  match_type TEXT,
  match_value TEXT,
  context TEXT,
  subject_email TEXT,
  subject_phone TEXT,
  subject_name TEXT,
  subject_organization TEXT,
  enforcement TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_owner_blocklist_hits_created ON owner_blocklist_hits(created_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMP;
