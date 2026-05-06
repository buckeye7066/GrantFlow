-- 0061_opportunity_verification_metadata.sql
--
-- Production reality gate (priority #1).
--
-- See backend/db/migrations/067_opportunity_verification_metadata.sql for the
-- full rationale. This is the Postgres mirror.

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS verification_method TEXT;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS verified_by TEXT;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS verification_error TEXT;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS link_status_code INTEGER;

UPDATE funding_opportunities
SET discovered_at = COALESCE(discovered_at, created_at, now())
WHERE discovered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_funding_opps_discovered_at
  ON funding_opportunities(discovered_at);
CREATE INDEX IF NOT EXISTS idx_funding_opps_verification_method
  ON funding_opportunities(verification_method);
