-- 183: SQLite twin of postgres 0188 — FUNDER-LEAD vs APPLY-READY separation
-- (owner directive 2026-08-23). Robert auto-adds qualifying national 990
-- funders to a profile's pipeline as a FUNDER_LEAD (a research/relationship
-- prospect under active investigation), never as an apply-ready opportunity
-- Hamilton could cold-submit. SQLite has no ADD COLUMN IF NOT EXISTS; each is
-- guarded by the migration runner's duplicate-column tolerance.
--
--   grants.pipeline_category               'funder_lead' | 'apply_ready' | NULL(=apply_ready)
--   grants.funder_lead_state               candidate | investigated | not_applicable | promoted
--   grants.funder_lead_attempts            bounded investigation attempts
--   grants.funder_lead_last_investigated_at last investigation timestamp
--   grant_transactions.recipient_is_individual  a PERSON recipient (recipient-type gate)
ALTER TABLE grants ADD COLUMN pipeline_category TEXT;
ALTER TABLE grants ADD COLUMN funder_lead_state TEXT;
ALTER TABLE grants ADD COLUMN funder_lead_attempts INTEGER DEFAULT 0;
ALTER TABLE grants ADD COLUMN funder_lead_last_investigated_at DATETIME;
ALTER TABLE grant_transactions ADD COLUMN recipient_is_individual BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_grants_pipeline_category ON grants(pipeline_category);
