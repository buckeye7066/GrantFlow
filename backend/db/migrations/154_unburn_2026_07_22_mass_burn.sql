-- Un-burn the rows the 2026-07-22 mass burn took (7th un-burn).
--
-- WHY. Eleven minutes after #1006 deployed (16:34Z), one sweep run burned 34
-- grants.gov + 4 federalregister.gov active-pipeline rows in ~5 seconds — each
-- API call failing ~150ms apart with the SAME stable-class reason, while every
-- one of those ids answers perfectly today (verified live from the prod egress,
-- 2026-07-25: 5/5 ids → HTTP 200, errorcode 0, real award ceilings). That was
-- the API having a degraded incident, not 38 facts about 38 rows. The code fix
-- is the SYSTEMIC-BURN GUARD (partitionSystemicStableFailures in
-- startup/enforceInvariants.js), but per the migration-135 rule a permanent
-- one-shot mark is a claim about the ROW and a fixed misclassification
-- re-opens it: the guard alone can never reach a row already burned.
--
-- Scope: the SAME two provable classes as un-burn 152 — adapter-covered hosts
-- and out-of-retries burns — because those are exactly the rows the 07-22
-- incident re-burned after 152 freed them. Resets ONLY the one-shot mark;
-- attempts/env counters and the last_reason breadcrumb are preserved.
-- Idempotent.
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
