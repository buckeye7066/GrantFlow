-- Migration 0073 (Postgres): persist the reality-gate verdict alongside
-- link health. See backend/db/migrations/077_funding_opportunities_reality_verdict.sql
-- for the full rationale.
--
-- Idempotent via ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS reality_status TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS reality_reasons JSONB;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS final_url TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS http_status INTEGER;

CREATE INDEX IF NOT EXISTS idx_funding_opportunities_reality_status
  ON funding_opportunities(reality_status);
