-- Un-burn answerless amount rows so the NEW adapter coverage can re-read them.
-- Twin of sqlite migration 152_unburn_for_adapter_coverage.sql — see it for
-- the full rationale (Simpler Grants fallback for the WAF-403-burned
-- grants.gov backlog; sam.gov /fal/ listing adapter; federalregister.gov
-- full-text adapter; transient-burn re-reads). The 6th un-burn: resets ONLY
-- the one-shot mark on ANSWERLESS rows, keeps `amount_enrich_attempts` so
-- MAX_ATTEMPTS still bounds a broken host. Idempotent.
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
