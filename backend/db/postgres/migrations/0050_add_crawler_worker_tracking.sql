-- Migration: Add worker identity and attempt tracking to crawler_jobs (Postgres).
--
-- Mirrors backend/db/migrations/057_add_crawler_worker_tracking.sql.
-- Columns are additive so this is safe to re-apply. Uses IF NOT EXISTS for
-- idempotency because Postgres migrations are strict (never auto-recorded on
-- failure by the migration runner).

ALTER TABLE crawler_jobs ADD COLUMN IF NOT EXISTS worker_id TEXT;
ALTER TABLE crawler_jobs ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0;
ALTER TABLE crawler_jobs ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crawler_jobs_worker_id ON crawler_jobs(worker_id);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status_heartbeat
  ON crawler_jobs(status, last_heartbeat_at);
