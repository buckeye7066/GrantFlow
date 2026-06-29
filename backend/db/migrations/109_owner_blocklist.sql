-- SQLite parity with backend/db/postgres/migrations/0106_owner_blocklist.sql
--
-- Owner personal blocklist: the single canonical denylist the OWNER feeds from
-- their phone (Tasker), Gmail filters (Apps Script / OAuth), and manual admin
-- entries. Enforced at auth (ban accounts), inbound contact (reject), and
-- outreach (mirrored into the John/Yana suppression lists at write time).
--
-- TEXT status/enforcement columns (not BOOLEAN) on purpose: the Postgres shim
-- only rewrites `col = 1/0` for an allowlist of known boolean columns, so a new
-- BOOLEAN would risk "operator does not exist: boolean = integer". Bare ALTERs
-- below are fine — backend/db/migrate.js ignores "duplicate column name".

CREATE TABLE IF NOT EXISTS owner_blocklist (
  id TEXT PRIMARY KEY,
  match_type TEXT NOT NULL,            -- email|domain|phone|last_name|organization|name
  match_value TEXT NOT NULL,           -- normalized lookup key
  match_value_raw TEXT,                -- original as entered (display)
  reason TEXT,
  source TEXT,                         -- manual|seed|tasker_phone|gmail_filter_sync|...
  enforcement TEXT NOT NULL DEFAULT 'block',  -- block|audit
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  added_by_user_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_blocklist_type_value ON owner_blocklist(match_type, match_value);
CREATE INDEX IF NOT EXISTS idx_owner_blocklist_type ON owner_blocklist(match_type);

CREATE TABLE IF NOT EXISTS owner_blocklist_hits (
  id TEXT PRIMARY KEY,
  blocklist_id TEXT,
  match_type TEXT,
  match_value TEXT,
  context TEXT,                        -- auth_signup|auth_login|inbound_contact|...
  subject_email TEXT,
  subject_phone TEXT,
  subject_name TEXT,
  subject_organization TEXT,
  enforcement TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_owner_blocklist_hits_created ON owner_blocklist_hits(created_at);

-- Account-ban support. Not added to schema.sql so a fresh-DB bootstrap never
-- collides with these ALTERs (which would roll back the whole migration).
ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE users ADD COLUMN blocked_reason TEXT;
ALTER TABLE users ADD COLUMN blocked_at DATETIME;
