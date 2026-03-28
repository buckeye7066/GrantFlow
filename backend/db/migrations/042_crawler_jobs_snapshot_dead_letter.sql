-- SQLite migration 042: crawler job snapshot/idempotency + dead-letter queue

-- Crawler job stability metadata
ALTER TABLE crawler_jobs ADD COLUMN profile_context_snapshot TEXT;
ALTER TABLE crawler_jobs ADD COLUMN idempotency_key TEXT;
ALTER TABLE crawler_jobs ADD COLUMN dispatch_attempts INTEGER DEFAULT 0;
ALTER TABLE crawler_jobs ADD COLUMN next_dispatch_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_crawler_jobs_next_dispatch ON crawler_jobs(next_dispatch_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crawler_jobs_idempotency ON crawler_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Dead Letter Queue for persistent failure tracking and recovery
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  job_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  profile_id TEXT,

  error_message TEXT NOT NULL,
  error_stack TEXT,
  error_code TEXT,

  retry_count INTEGER DEFAULT 0,
  last_retry_at DATETIME,
  next_retry_at DATETIME,

  job_parameters TEXT,
  profile_context_snapshot TEXT,

  severity TEXT CHECK(severity IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium',
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at DATETIME,
  resolved_by TEXT,
  resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_job_type ON dead_letter_queue(job_type, resolved);
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_profile_id ON dead_letter_queue(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_unresolved ON dead_letter_queue(created_at) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_retry ON dead_letter_queue(next_retry_at) WHERE next_retry_at IS NOT NULL AND resolved = FALSE;

