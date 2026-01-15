-- Adds idempotency key support for scheduled jobs (SQLite)
-- This is safe to run multiple times in SQLite installs.

ALTER TABLE crawler_jobs ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_crawler_jobs_idempotency_key
  ON crawler_jobs(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND LENGTH(TRIM(idempotency_key)) > 0;

