-- Phase 6: Geo crawler full run + state-indexed summary
-- Track per-state geo crawl runs so we can report last run + counts per state.

CREATE TABLE IF NOT EXISTS geo_state_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  job_id TEXT REFERENCES crawler_jobs(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
  processed_zips INTEGER DEFAULT 0,
  sources_inserted INTEGER DEFAULT 0,
  failed_zips INTEGER DEFAULT 0,
  skipped_zips INTEGER DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geo_state_runs_state ON geo_state_runs(state);
CREATE INDEX IF NOT EXISTS idx_geo_state_runs_created_at ON geo_state_runs(created_at);

