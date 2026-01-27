-- Geo Crawl geo-index (associate global opportunities with many ZIPs/runs)
-- Preserves global de-dupe while enabling per-run/per-zip attribution.

CREATE TABLE IF NOT EXISTS funding_opportunity_geo_index (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  geo_run_id TEXT,
  state TEXT,
  zip TEXT,
  county TEXT,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_fo_geo_index
  ON funding_opportunity_geo_index(opportunity_id, geo_run_id, state, zip, source);

CREATE INDEX IF NOT EXISTS idx_fo_geo_index_run_id
  ON funding_opportunity_geo_index(geo_run_id);

CREATE INDEX IF NOT EXISTS idx_fo_geo_index_state
  ON funding_opportunity_geo_index(state);

CREATE INDEX IF NOT EXISTS idx_fo_geo_index_zip
  ON funding_opportunity_geo_index(zip);

CREATE INDEX IF NOT EXISTS idx_fo_geo_index_opp
  ON funding_opportunity_geo_index(opportunity_id);

