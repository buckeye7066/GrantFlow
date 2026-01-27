-- Geo Crawl geo-index (associate global opportunities with many ZIPs/runs)
-- This preserves global de-dupe (one opportunity row) while still allowing:
-- - filtering a run by geo_run_id
-- - counting/attributing results per ZIP/state without overwriting geo_* columns

CREATE TABLE IF NOT EXISTS funding_opportunity_geo_index (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  geo_run_id TEXT,
  state TEXT,
  zip TEXT,
  county TEXT,
  source TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

