-- Add indexes for common query patterns on funding_opportunities.
-- Safe for both SQLite and Postgres (CREATE INDEX IF NOT EXISTS is supported by both).

-- Speeds up the default list query (is_active = true filter).
CREATE INDEX IF NOT EXISTS idx_fo_is_active
  ON funding_opportunities(is_active);

-- State + is_active: covers state-scoped list queries.
CREATE INDEX IF NOT EXISTS idx_fo_state_active
  ON funding_opportunities(state, is_active);

-- Source + is_active: covers source-filtered list queries.
CREATE INDEX IF NOT EXISTS idx_fo_source_active
  ON funding_opportunities(source, is_active);

-- National flag + is_active: covers is_national=true filter and national minimum guarantee.
CREATE INDEX IF NOT EXISTS idx_fo_national_active
  ON funding_opportunities(is_national, is_active);

-- Deadline: supports ORDER BY deadline and deadline range filters.
CREATE INDEX IF NOT EXISTS idx_fo_deadline
  ON funding_opportunities(deadline);

-- Deadline type: used in expiry/rolling/ongoing checks.
CREATE INDEX IF NOT EXISTS idx_fo_deadline_type
  ON funding_opportunities(deadline_type);

-- Source ID: used in deduplication and identity lookups.
CREATE INDEX IF NOT EXISTS idx_fo_source_id
  ON funding_opportunities(source_id);

-- Geo index table: composite index for geo_run_id + opportunity_id lookups.
-- Only applies if the table exists (created by migration 019).
CREATE INDEX IF NOT EXISTS idx_fo_geo_run_opp
  ON funding_opportunity_geo_index(geo_run_id, opportunity_id);
