-- Adds idempotency key support for scheduled jobs (Postgres) - strict/deterministic

ALTER TABLE crawler_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_crawler_jobs_idempotency_key
  ON crawler_jobs(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND LENGTH(BTRIM(idempotency_key)) > 0;

