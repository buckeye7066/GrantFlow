-- SQLite parity with backend/db/postgres/migrations/0094_hamilton_portal_credentials.sql
-- Per-profile saved portal logins (password encrypted at rest by the service).
CREATE TABLE IF NOT EXISTS hamilton_portal_credentials (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,
  label TEXT,
  login_url TEXT,
  username TEXT,
  password_ciphertext TEXT,
  password_iv TEXT,
  password_tag TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hamilton_portal_cred_profile_host
  ON hamilton_portal_credentials(profile_id, portal_host);
CREATE INDEX IF NOT EXISTS idx_hamilton_portal_cred_profile
  ON hamilton_portal_credentials(profile_id);
