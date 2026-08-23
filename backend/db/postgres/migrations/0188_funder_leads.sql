-- 0188: FUNDER-LEAD vs APPLY-READY separation (owner directive 2026-08-23).
--
-- Robert autonomously adds qualifying national 990 funders to a profile's
-- pipeline as a FUNDER_LEAD — a research/relationship prospect he then actively
-- INVESTIGATES. A funder lead has no confirmed application path and MUST NOT be
-- selected by Hamilton's auto-submit; only a lead investigation confirms has a
-- real applicable path is PROMOTED to the apply-ready funding-source side, where
-- Hamilton (on a fully-autonomous profile) handles it normally.
--
--   grants.pipeline_category   'funder_lead' | 'apply_ready' | NULL(=apply_ready)
--   grants.funder_lead_state   candidate | investigated | not_applicable | promoted
--   grant_transactions.recipient_is_individual — a PERSON recipient
--     (RecipientPersonNm), the basis for the recipient-type gate: a private
--     foundation that gives org-to-org cannot be applied to by an individual.
ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS pipeline_category text,
  ADD COLUMN IF NOT EXISTS funder_lead_state text,
  ADD COLUMN IF NOT EXISTS funder_lead_attempts integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS funder_lead_last_investigated_at timestamptz;

ALTER TABLE grant_transactions
  ADD COLUMN IF NOT EXISTS recipient_is_individual boolean DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_grants_pipeline_category ON grants(pipeline_category);
