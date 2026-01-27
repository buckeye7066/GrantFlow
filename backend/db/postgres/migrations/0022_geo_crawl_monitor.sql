-- Durable Geo Crawl run tracking + live event log
-- (Postgres)

CREATE TABLE IF NOT EXISTS geo_crawl_runs (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by_user_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','failed','complete')),
  state TEXT NULL,
  current_zip TEXT NULL,
  current_county TEXT NULL,
  current_source TEXT NULL,
  processed_zip_count INTEGER DEFAULT 0,
  found_opportunity_count INTEGER DEFAULT 0,
  last_heartbeat_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  crawler_job_id TEXT NULL REFERENCES crawler_jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_geo_crawl_runs_status ON geo_crawl_runs(status);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_runs_state ON geo_crawl_runs(state);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_runs_job ON geo_crawl_runs(crawler_job_id);

CREATE TABLE IF NOT EXISTS geo_crawl_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES geo_crawl_runs(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ DEFAULT now(),
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error')),
  state TEXT NULL,
  zip TEXT NULL,
  county TEXT NULL,
  source TEXT NULL,
  message TEXT NULL,
  found_count_delta INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id ON geo_crawl_events(run_id);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id_id ON geo_crawl_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id_ts ON geo_crawl_events(run_id, ts);

-- Tag geo-discovered opportunities so Opportunities can filter by run
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_run_id TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_zip TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_county TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_source TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_scope TEXT;

CREATE INDEX IF NOT EXISTS idx_funding_geo_run ON funding_opportunities(geo_run_id);
CREATE INDEX IF NOT EXISTS idx_funding_geo_state ON funding_opportunities(state);
CREATE INDEX IF NOT EXISTS idx_funding_geo_state_run ON funding_opportunities(state, geo_run_id);

