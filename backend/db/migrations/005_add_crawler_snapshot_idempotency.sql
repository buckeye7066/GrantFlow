-- Migration: Add profile_context_snapshot and idempotency_key to crawler_jobs
-- Purpose: Enable deterministic crawler execution with snapshot storage

-- Add profile_context_snapshot column
ALTER TABLE crawler_jobs ADD COLUMN profile_context_snapshot TEXT;

-- Add idempotency_key column
ALTER TABLE crawler_jobs ADD COLUMN idempotency_key TEXT;

-- Create unique index on idempotency_key (for deduplication)
CREATE UNIQUE INDEX IF NOT EXISTS idx_crawler_jobs_idempotency 
ON crawler_jobs(idempotency_key) 
WHERE idempotency_key IS NOT NULL;
