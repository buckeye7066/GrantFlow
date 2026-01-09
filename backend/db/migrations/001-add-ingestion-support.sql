-- Migration 001: Add Real Ingestion Support
-- Adds columns and tables needed for real data ingestion from external sources

-- Add raw_source_payload column to store original API response
ALTER TABLE funding_opportunities ADD COLUMN raw_source_payload TEXT;

-- Add unique constraint for deduplication (source + source_id must be unique)
CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_source_source_id 
ON funding_opportunities(source, source_id) 
WHERE source IS NOT NULL AND source_id IS NOT NULL;

-- Create ingestion_runs table to track ingestion history
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source TEXT NOT NULL,
  started_at DATETIME NOT NULL,
  completed_at DATETIME,
  status TEXT CHECK(status IN ('running', 'completed', 'failed')) DEFAULT 'running',
  records_fetched INTEGER DEFAULT 0,
  records_inserted INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  error_message TEXT
);

-- Add index for querying recent ingestion runs
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_source_started 
ON ingestion_runs(source, started_at DESC);
