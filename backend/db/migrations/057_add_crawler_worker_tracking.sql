-- Migration: Add worker identity and attempt tracking to crawler_jobs.
--
-- Why:
--   - worker_id proves which process owns a running job. It lets us detect and
--     reclaim jobs abandoned by crashed workers, and makes it visible in ops
--     tooling which process is doing what.
--   - attempt_count is a persistent counter (survives backoff / retries /
--     restarts) that is incremented every time a worker successfully claims
--     the job. dispatch_attempts is reset on re-queue and retry_count only
--     ticks on stale-orphan cleanup, so neither is sufficient on its own.
--   - claimed_at is the exact moment the queued -> running transition was
--     applied, independent of started_at semantics elsewhere.
--
-- These are additive (ADD COLUMN) so they are safe for existing rows.
-- SQLite does not support IF NOT EXISTS on ADD COLUMN; the migration runner
-- treats "duplicate column name" as already-applied (see backend/db/migrate.js).

ALTER TABLE crawler_jobs ADD COLUMN worker_id TEXT;
ALTER TABLE crawler_jobs ADD COLUMN attempt_count INTEGER DEFAULT 0;
ALTER TABLE crawler_jobs ADD COLUMN claimed_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_crawler_jobs_worker_id ON crawler_jobs(worker_id);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status_heartbeat
  ON crawler_jobs(status, last_heartbeat_at);
