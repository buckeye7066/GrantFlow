-- Migration 017: Add health_resources crawler job type
-- Date: 2026-01-27
--
-- SQLite limitation: cannot ALTER CHECK constraints in place; recreate crawler_jobs.

-- Create new table with updated CHECK constraint (keep current columns).
CREATE TABLE IF NOT EXISTS crawler_jobs_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  
  type TEXT NOT NULL CHECK(type IN (
    'local',
    'scholarship',
    'health_resources',
    'comprehensive',
    'national',
    'item_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
    'national_zip_scan'
  )),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled'
  )),
  
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  
  parameters TEXT DEFAULT '{}',
  profile_context_snapshot TEXT,
  idempotency_key TEXT,
  result_count INTEGER DEFAULT 0,
  result_meta TEXT,
  error TEXT,
  requested_by TEXT,
  dispatch_attempts INTEGER DEFAULT 0,
  next_dispatch_at DATETIME,
  retry_count INTEGER DEFAULT 0,
  last_retry_at DATETIME
);

INSERT INTO crawler_jobs_new (
  id,
  created_at,
  started_at,
  completed_at,
  type,
  status,
  profile_id,
  organization_id,
  parameters,
  profile_context_snapshot,
  idempotency_key,
  result_count,
  result_meta,
  error,
  requested_by,
  dispatch_attempts,
  next_dispatch_at,
  retry_count,
  last_retry_at
)
SELECT
  id,
  created_at,
  started_at,
  completed_at,
  type,
  status,
  profile_id,
  organization_id,
  parameters,
  profile_context_snapshot,
  idempotency_key,
  result_count,
  result_meta,
  error,
  requested_by,
  dispatch_attempts,
  next_dispatch_at,
  retry_count,
  last_retry_at
FROM crawler_jobs;

DROP TABLE crawler_jobs;
ALTER TABLE crawler_jobs_new RENAME TO crawler_jobs;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status ON crawler_jobs(status);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_profile ON crawler_jobs(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_type ON crawler_jobs(type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crawler_jobs_idempotency ON crawler_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

