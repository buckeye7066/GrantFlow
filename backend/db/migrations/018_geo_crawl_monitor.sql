-- Durable Geo Crawl run tracking + live event log
-- (SQLite)

-- 1) Run snapshot table (single row per geo crawl run)
CREATE TABLE IF NOT EXISTS geo_crawl_runs (
  id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','failed','complete')),
  state TEXT,
  current_zip TEXT,
  current_county TEXT,
  current_source TEXT,
  processed_zip_count INTEGER DEFAULT 0,
  found_opportunity_count INTEGER DEFAULT 0,
  last_heartbeat_at DATETIME,
  last_error TEXT,
  crawler_job_id TEXT REFERENCES crawler_jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_geo_crawl_runs_status ON geo_crawl_runs(status);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_runs_state ON geo_crawl_runs(state);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_runs_job ON geo_crawl_runs(crawler_job_id);

-- 2) Append-only event log for UI tailing
CREATE TABLE IF NOT EXISTS geo_crawl_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES geo_crawl_runs(id) ON DELETE CASCADE,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error')),
  state TEXT,
  zip TEXT,
  county TEXT,
  source TEXT,
  message TEXT,
  found_count_delta INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id ON geo_crawl_events(run_id);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id_id ON geo_crawl_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id_ts ON geo_crawl_events(run_id, ts);

-- 3) Tag geo-discovered opportunities so the Opportunities page can show them live
ALTER TABLE funding_opportunities ADD COLUMN geo_run_id TEXT;
ALTER TABLE funding_opportunities ADD COLUMN geo_zip TEXT;
ALTER TABLE funding_opportunities ADD COLUMN geo_county TEXT;
ALTER TABLE funding_opportunities ADD COLUMN geo_source TEXT;
ALTER TABLE funding_opportunities ADD COLUMN geo_scope TEXT;

CREATE INDEX IF NOT EXISTS idx_funding_geo_run ON funding_opportunities(geo_run_id);
CREATE INDEX IF NOT EXISTS idx_funding_geo_state ON funding_opportunities(state);
CREATE INDEX IF NOT EXISTS idx_funding_geo_state_run ON funding_opportunities(state, geo_run_id);

