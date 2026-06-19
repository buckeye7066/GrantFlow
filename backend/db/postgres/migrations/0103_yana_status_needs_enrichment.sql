-- Widen yana_lead_candidates.qualification_status CHECK to include the
-- outbound-prospect status 'needs_enrichment' (a real org discovered with
-- public evidence but no contact channel yet).
--
-- The original constraint (0089) only allowed candidate/qualified/unqualified.
-- When outbound prospect discovery (ProPublica 990 -> Brave enrichment) landed,
-- it began writing 'needs_enrichment', which violated this CHECK and aborted the
-- ENTIRE Yana run — so no prospect, qualified or not, was ever persisted.

ALTER TABLE yana_lead_candidates
  DROP CONSTRAINT IF EXISTS yana_lead_candidates_qualification_status_check;

ALTER TABLE yana_lead_candidates
  ADD CONSTRAINT yana_lead_candidates_qualification_status_check
  CHECK (qualification_status IN ('candidate', 'qualified', 'unqualified', 'needs_enrichment'));
