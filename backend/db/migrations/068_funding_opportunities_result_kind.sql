-- 068: Direct opportunity vs. directory/referral classification.
-- @sqlite-continue-on-idempotent-errors
--
-- Honors the trust rule: "Show users opportunities clearly so they can
-- discover, review, and act on them — and never let a directory/referral
-- masquerade as a direct grant."
--
-- result_kind values:
--   direct        — a grant, scholarship, award, or assistance program with
--                   a real application path
--   benefit       — a public/nonprofit assistance program the user applies
--                   to (SNAP, Medicaid, LIHEAP, WIC, voucher programs, etc.)
--   directory     — a search/finder/referral resource — not itself the
--                   funding source. Stays visible (labelled) so the user
--                   can find help nearby, but never sold as a grant.
--   school_portal — institutional financial aid page (apply through school)
--   action_step   — task/training/program (not direct cash) that's a useful
--                   next step toward funding
--
-- is_hidden is a soft-hide flag set by the recurring verifier when a direct
-- opportunity's link goes broken; directories stay visible (labelled) so the
-- user can still find help nearby.

ALTER TABLE funding_opportunities ADD COLUMN result_kind TEXT;
ALTER TABLE funding_opportunities ADD COLUMN is_hidden INTEGER DEFAULT 0;

-- Backfill: existing rows get a best-effort classification from
-- opportunity_type / type. New inserts will receive a fresh classification
-- via opportunityInserter.classifyResultKind().
UPDATE funding_opportunities
SET result_kind = CASE
    WHEN type = 'DIRECTORY' THEN 'directory'
    WHEN opportunity_type IN ('directory', 'referral') THEN 'directory'
    WHEN opportunity_type IN ('benefit', 'assistance', 'subsidy', 'voucher', 'rebate', 'service', 'in_kind', 'pro_bono', 'credit') THEN 'benefit'
    WHEN opportunity_type IN ('training', 'program') THEN 'action_step'
    ELSE 'direct'
END
WHERE result_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_funding_opps_result_kind ON funding_opportunities(result_kind);
CREATE INDEX IF NOT EXISTS idx_funding_opps_is_hidden ON funding_opportunities(is_hidden);
