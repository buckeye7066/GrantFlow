-- SQLite parity with backend/db/postgres/migrations/0104_hamilton_portal_credentials_totp.sql
-- Legacy columns for encrypted authenticator-app (TOTP) seeds.
-- Hamilton no longer stores or uses these values; migration 127 wipes any
-- legacy seed material while keeping the columns for schema compatibility.
-- Bare ALTER is fine: backend/db/migrate.js ignores "duplicate column name"
-- when ensureSchema already self-healed the column.
ALTER TABLE hamilton_portal_credentials ADD COLUMN totp_secret_ciphertext TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN totp_secret_iv TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN totp_secret_tag TEXT;
