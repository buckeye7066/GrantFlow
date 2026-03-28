-- Add last_heartbeat_at column to crawler_jobs.
-- This is updated periodically by long-running jobs to prove liveness.
-- cleanupStaleCrawlers will skip jobs with a recent heartbeat even if started_at is old.
ALTER TABLE crawler_jobs ADD COLUMN last_heartbeat_at DATETIME;
