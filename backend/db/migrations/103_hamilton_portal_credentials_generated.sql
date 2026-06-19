-- SQLite parity with backend/db/postgres/migrations/0100_hamilton_portal_credentials_generated.sql
-- Each ALTER is wrapped so re-running on a db that already has the column
-- (because ensureSchema in the service self-healed it) is a no-op.
ALTER TABLE hamilton_portal_credentials ADD COLUMN generated_by TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN generation_reason TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN generated_at DATETIME;
ALTER TABLE hamilton_portal_credentials ADD COLUMN password_revealed_once_at DATETIME;
