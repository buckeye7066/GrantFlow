-- 0098_yana_prospect_columns.sql (Postgres)
--
-- Yana outbound prospect discovery — see the SQLite twin
-- (101_yana_prospect_columns.sql) for rationale. Adds:
--   - source       discovery source that produced the row
--   - external_id  source's stable id (e.g. EIN) for cross-run dedupe
-- Idempotent: ADD COLUMN IF NOT EXISTS, safe to re-run.

ALTER TABLE yana_lead_candidates ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'organizations';
ALTER TABLE yana_lead_candidates ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE INDEX IF NOT EXISTS idx_yana_candidates_source       ON yana_lead_candidates(source);
CREATE INDEX IF NOT EXISTS idx_yana_candidates_external_id  ON yana_lead_candidates(external_id);
