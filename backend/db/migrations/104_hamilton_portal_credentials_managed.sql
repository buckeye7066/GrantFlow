-- SQLite parity with backend/db/postgres/migrations/0101_hamilton_portal_credentials_managed.sql
-- Adds managed_by provenance and allows multiple logins per (profile, host).
-- Bare ALTER is fine: backend/db/migrate.js ignores "duplicate column name"
-- when ensureSchema already self-healed the column.
ALTER TABLE hamilton_portal_credentials ADD COLUMN managed_by TEXT;

UPDATE hamilton_portal_credentials SET managed_by = 'admin'
  WHERE managed_by IS NULL AND user_id = 'system_admin_token';
UPDATE hamilton_portal_credentials SET managed_by = 'hamilton'
  WHERE managed_by IS NULL AND generated_by IS NOT NULL;
UPDATE hamilton_portal_credentials SET managed_by = 'user'
  WHERE managed_by IS NULL;

DROP INDEX IF EXISTS ux_hamilton_portal_cred_profile_host;
CREATE UNIQUE INDEX IF NOT EXISTS ux_hamilton_portal_cred_profile_host_user
  ON hamilton_portal_credentials(profile_id, portal_host, username);
CREATE INDEX IF NOT EXISTS idx_hamilton_portal_cred_managed_by
  ON hamilton_portal_credentials(managed_by);
