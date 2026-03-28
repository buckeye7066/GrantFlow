-- Migration: Add dead-letter queue for crawler job failures
-- This provides durable logging of failures for diagnosis and recovery

-- Create dead_letter_queue table for persistent failure tracking
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- Job context
  job_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  profile_id TEXT,
  
  -- Failure details
  error_message TEXT NOT NULL,
  error_stack TEXT,
  error_code TEXT,
  
  -- Retry information
  retry_count INTEGER DEFAULT 0,
  last_retry_at DATETIME,
  next_retry_at DATETIME,
  
  -- Job state snapshot
  job_parameters TEXT, -- JSON snapshot of job parameters
  profile_context_snapshot TEXT, -- JSON snapshot of profile context
  
  -- Metadata
  severity TEXT CHECK(severity IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium',
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at DATETIME,
  resolved_by TEXT,
  resolution_notes TEXT,
  
  FOREIGN KEY (job_id) REFERENCES crawler_jobs(id) ON DELETE CASCADE
);

-- Index for querying failures by job type and resolution status
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_job_type ON dead_letter_queue(job_type, resolved);

-- Index for querying failures by profile
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_profile_id ON dead_letter_queue(profile_id) WHERE profile_id IS NOT NULL;

-- Index for querying unresolved failures by created_at
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_unresolved ON dead_letter_queue(created_at) WHERE resolved = FALSE;

-- Index for retry scheduling
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_retry ON dead_letter_queue(next_retry_at) WHERE next_retry_at IS NOT NULL AND resolved = FALSE;
