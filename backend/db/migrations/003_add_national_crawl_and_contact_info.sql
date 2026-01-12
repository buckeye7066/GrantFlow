-- Migration 003: Add contact info + crawler logs + updated crawler job constraints
-- Date: 2026-01-09

-- Add contact_info to funding_opportunities table
-- Contact information stored as JSON: { name, email, phone, address, website }
ALTER TABLE funding_opportunities ADD COLUMN contact_info TEXT DEFAULT NULL;

-- Update crawler_jobs table constraint (schema-aligned; Geo Crawl uses type='comprehensive' + parameters.mode='geo')
-- Note: SQLite doesn't support modifying CHECK constraints directly
-- We need to recreate the table with the updated constraint

-- Create new table with updated CHECK constraint
CREATE TABLE IF NOT EXISTS crawler_jobs_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  
  type TEXT NOT NULL CHECK(type IN (
    'local',
    'scholarship',
    'comprehensive',
    'item_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment'
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
  result_count INTEGER DEFAULT 0,
  result_meta TEXT,
  error TEXT,
  requested_by TEXT,
  retry_count INTEGER DEFAULT 0,
  last_retry_at DATETIME
);

-- Copy data from old table to new table
INSERT INTO crawler_jobs_new 
SELECT * FROM crawler_jobs;

-- Drop old table and rename new table
DROP TABLE crawler_jobs;
ALTER TABLE crawler_jobs_new RENAME TO crawler_jobs;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status ON crawler_jobs(status);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_profile ON crawler_jobs(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_type ON crawler_jobs(type);

-- Create crawl_logs table if it doesn't exist (for test harness logging)
CREATE TABLE IF NOT EXISTS crawl_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  job_id TEXT REFERENCES crawler_jobs(id) ON DELETE SET NULL,
  crawler_type TEXT,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  status TEXT CHECK(status IN ('success', 'failure', 'partial')),
  opportunities_found INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  metadata TEXT DEFAULT '{}' -- JSON for additional info
);

CREATE INDEX IF NOT EXISTS idx_crawl_logs_created ON crawl_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_crawl_logs_crawler_type ON crawl_logs(crawler_type);
CREATE INDEX IF NOT EXISTS idx_crawl_logs_profile ON crawl_logs(profile_id);
