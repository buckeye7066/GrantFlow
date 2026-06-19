-- SQLite parity with backend/db/postgres/migrations/0102_application_tasks_auth_retry.sql
-- next_retry_at / retry_count drive Hamilton's auto-retry backup plan for
-- login/2FA/captcha-blocked tasks. Bare ALTERs are fine: backend/db/migrate.js
-- ignores "duplicate column name" when ensureColumn already self-healed them.
ALTER TABLE application_tasks ADD COLUMN next_retry_at DATETIME;
ALTER TABLE application_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_application_tasks_next_retry
  ON application_tasks(next_retry_at);
