-- Add crawler job idempotency + dispatch backpressure metadata (SQLite)

ALTER TABLE crawler_jobs ADD COLUMN idempotency_key TEXT;
ALTER TABLE crawler_jobs ADD COLUMN dispatch_attempts INTEGER DEFAULT 0;
ALTER TABLE crawler_jobs ADD COLUMN next_dispatch_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_crawler_jobs_next_dispatch ON crawler_jobs(next_dispatch_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_crawler_jobs_idempotency_key
  ON crawler_jobs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

