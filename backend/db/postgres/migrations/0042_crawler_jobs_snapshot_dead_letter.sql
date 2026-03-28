-- Postgres migration 0010: crawler job snapshot + dead-letter queue

-- Crawler job stability metadata
ALTER TABLE crawler_jobs
  ADD COLUMN IF NOT EXISTS profile_context_snapshot TEXT;

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

-- Dead Letter Queue for persistent failure tracking and recovery
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  created_at TIMESTAMPTZ DEFAULT now(),

  job_id TEXT NOT NULL REFERENCES crawler_jobs(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  profile_id TEXT,

  error_message TEXT NOT NULL,
  error_stack TEXT,
  error_code TEXT,

  retry_count INTEGER DEFAULT 0,
  last_retry_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,

  job_parameters TEXT,
  profile_context_snapshot TEXT,

  severity TEXT DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_job_type ON dead_letter_queue(job_type, resolved);
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_profile_id ON dead_letter_queue(profile_id);
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_unresolved ON dead_letter_queue(created_at) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_retry ON dead_letter_queue(next_retry_at) WHERE next_retry_at IS NOT NULL AND resolved = FALSE;

