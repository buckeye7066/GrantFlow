-- Postgres migration 0010: crawler job idempotency + dispatch backpressure metadata

ALTER TABLE crawler_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE crawler_jobs
  ADD COLUMN IF NOT EXISTS dispatch_attempts INTEGER DEFAULT 0;

ALTER TABLE crawler_jobs
  ADD COLUMN IF NOT EXISTS next_dispatch_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crawler_jobs_next_dispatch ON crawler_jobs(next_dispatch_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_crawler_jobs_idempotency_key
  ON crawler_jobs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

