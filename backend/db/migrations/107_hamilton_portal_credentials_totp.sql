-- SQLite parity with backend/db/postgres/migrations/0104_hamilton_portal_credentials_totp.sql
-- Adds an encrypted authenticator-app (TOTP) seed to saved portal logins so
-- Hamilton can clear a 2FA gate unattended instead of hard-stopping.
-- Bare ALTER is fine: backend/db/migrate.js ignores "duplicate column name"
-- when ensureSchema already self-healed the column.
ALTER TABLE hamilton_portal_credentials ADD COLUMN totp_secret_ciphertext TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN totp_secret_iv TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN totp_secret_tag TEXT;
