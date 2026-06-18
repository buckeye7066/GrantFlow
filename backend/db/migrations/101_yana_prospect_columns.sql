-- 101_yana_prospect_columns.sql (SQLite)
--
-- Yana outbound prospect discovery. yana_lead_candidates previously only held
-- candidates derived from the operator's OWN organizations. Yana now also
-- discovers EXTERNAL prospects (grant-seeking nonprofits via ProPublica 990)
-- for John to do outreach. Two columns support that:
--   - source       which discovery source produced the row
--                  ('organizations' = legacy self-scan, 'propublica_990', …)
--   - external_id  the source's stable id (e.g. EIN) for cross-run dedupe
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; the boot/ensureSchema self-heal
-- tolerates duplicate-column errors, so re-applying is harmless.

ALTER TABLE yana_lead_candidates ADD COLUMN source TEXT DEFAULT 'organizations';
ALTER TABLE yana_lead_candidates ADD COLUMN external_id TEXT;

CREATE INDEX IF NOT EXISTS idx_yana_candidates_source       ON yana_lead_candidates(source);
CREATE INDEX IF NOT EXISTS idx_yana_candidates_external_id  ON yana_lead_candidates(external_id);
