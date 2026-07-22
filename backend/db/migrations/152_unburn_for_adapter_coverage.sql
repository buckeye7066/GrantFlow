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
--
-- The 6th un-burn (cf. 138-141, 143), scope NARROWED per the adversarial gate:
-- resetting every answerless burn would silently re-open rows whose failure is
-- STABLE and adapter-less (a 404, a genuine JS shell on an unadapted host).
-- Two provable classes only:
--   1. ADAPTER-COVERED hosts (grants.gov / sam.gov /fal/ / federalregister.gov
--     on any URL slot) — the new doors read these.
--   2. OUT-OF-RETRIES burns (amount_enrich_attempts >= 3): burned by
--     MAX_ATTEMPTS consecutive TRANSIENT failures — the outage-window class
--     migrations 138-143 kept recovering (a STABLE thin_page/404 burns on its
--     first attempt with attempts = 1, so it stays burned).
-- Only the one-shot mark is reset; a row carrying any recorded answer is
-- untouched, and `amount_enrich_attempts` is preserved so MAX_ATTEMPTS still
-- bounds a genuinely broken host. Idempotent for stable-failure rows (a
-- re-burned adapter-host row re-enters only until its adapter answers).
UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '')
   AND COALESCE(source_url, application_url, evidence_url) IS NOT NULL
   AND (
        COALESCE(source_url, '')      LIKE '%grants.gov%' OR
        COALESCE(application_url, '') LIKE '%grants.gov%' OR
        COALESCE(evidence_url, '')    LIKE '%grants.gov%' OR
        COALESCE(source_url, '')      LIKE '%sam.gov/fal/%' OR
        COALESCE(application_url, '') LIKE '%sam.gov/fal/%' OR
        COALESCE(evidence_url, '')    LIKE '%sam.gov/fal/%' OR
        COALESCE(source_url, '')      LIKE '%federalregister.gov%' OR
        COALESCE(application_url, '') LIKE '%federalregister.gov%' OR
        COALESCE(evidence_url, '')    LIKE '%federalregister.gov%' OR
        COALESCE(amount_enrich_attempts, 0) >= 3
   );

UPDATE grants
   SET amount_enrich_attempted_at = NULL
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_requested, 0) <= 0
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '')
   AND COALESCE(url, application_url, '') <> ''
   AND (
        COALESCE(url, '')             LIKE '%grants.gov%' OR
        COALESCE(application_url, '') LIKE '%grants.gov%' OR
        COALESCE(url, '')             LIKE '%sam.gov/fal/%' OR
        COALESCE(application_url, '') LIKE '%sam.gov/fal/%' OR
        COALESCE(url, '')             LIKE '%federalregister.gov%' OR
        COALESCE(application_url, '') LIKE '%federalregister.gov%' OR
        COALESCE(amount_enrich_attempts, 0) >= 3
   );
