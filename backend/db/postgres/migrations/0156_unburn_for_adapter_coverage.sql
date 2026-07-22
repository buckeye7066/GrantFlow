-- Un-burn answerless amount rows so the NEW adapter coverage can re-read them.
-- Twin of sqlite migration 152_unburn_for_adapter_coverage.sql — see it for
-- the full rationale. The 6th un-burn, scope NARROWED per the adversarial
-- gate to two provable classes: (1) adapter-covered hosts (grants.gov,
-- sam.gov /fal/, federalregister.gov — the new doors read these), and
-- (2) out-of-retries burns (attempts >= 3 = MAX_ATTEMPTS consecutive
-- TRANSIENT failures; a stable thin_page/404 burns at attempts = 1 and stays
-- burned). Resets ONLY the one-shot mark; attempts preserved. Idempotent for
-- stable-failure rows.
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
