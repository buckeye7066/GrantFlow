-- Un-burn answerless amount rows so the NEW adapter coverage can re-read them.
-- Twin: postgres migration 0156_unburn_for_adapter_coverage.sql.
--
-- Fix-cycle 3 (2026-07-22). The amount sweeps just gained three real doors the
-- burned backlog never had a chance to use:
--   - grants.gov rows: a Simpler Grants API fallback (separate HHS infra,
--     key-gated) that answers even while api.grants.gov WAF-403s prod egress —
--     the block that burned every grants.gov row answerless (104 in the
--     2026-07-22 census);
--   - sam.gov /fal/ assistance listings (43): the listing's own published
--     "Range and Average of Financial Assistance" text via SAM's listing API;
--   - federalregister.gov documents (19): the document's FULL plain text via
--     the FR API (the page fetch saw at most a 12k-char window).
-- Plus the #958-era lesson that several rows burned during transient outages
-- read fine on a re-fetch.
--
-- The 6th un-burn (cf. 138-141, 143). Same shape as its predecessors: reset
-- ONLY the one-shot mark on rows that are ANSWERLESS (no figure, no honest
-- label, no denial) — a row carrying any recorded answer is untouched, and
-- `amount_enrich_attempts` is NOT reset, so MAX_ATTEMPTS still bounds a
-- genuinely broken host. A genuine JS shell re-burns after one bounded fetch.
-- Idempotent: the second run matches zero rows.
UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '')
   AND COALESCE(source_url, application_url, evidence_url) IS NOT NULL;

UPDATE grants
   SET amount_enrich_attempted_at = NULL
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_requested, 0) <= 0
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '')
   AND COALESCE(url, application_url, '') <> '';
