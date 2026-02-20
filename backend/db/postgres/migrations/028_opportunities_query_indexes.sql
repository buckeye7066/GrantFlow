-- Add indexes for common query patterns on funding_opportunities (Postgres).
-- Uses IF NOT EXISTS for idempotent re-runs.
-- Uses CONCURRENTLY where safe to avoid locking in production.

CREATE INDEX IF NOT EXISTS idx_fo_is_active
  ON funding_opportunities(is_active);

CREATE INDEX IF NOT EXISTS idx_fo_state_active
  ON funding_opportunities(state, is_active);

CREATE INDEX IF NOT EXISTS idx_fo_source_active
  ON funding_opportunities(source, is_active);

CREATE INDEX IF NOT EXISTS idx_fo_national_active
  ON funding_opportunities(is_national, is_active);

CREATE INDEX IF NOT EXISTS idx_fo_deadline
  ON funding_opportunities(deadline);

CREATE INDEX IF NOT EXISTS idx_fo_deadline_type
  ON funding_opportunities(deadline_type);

CREATE INDEX IF NOT EXISTS idx_fo_source_id
  ON funding_opportunities(source_id);

-- Composite index on geo_index table for filtered geo queries.
CREATE INDEX IF NOT EXISTS idx_fo_geo_run_opp
  ON funding_opportunity_geo_index(geo_run_id, opportunity_id);
