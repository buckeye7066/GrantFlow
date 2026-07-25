-- Un-burn rows whose recorded ANSWER was wiped by a re-crawl (8th un-burn).
-- Twin of sqlite migration 155_unburn_wiped_adapter_answers.sql.
--
-- WHY. Caught live 2026-07-25: the deploy-boot sweep answered 10 rows via the
-- API adapters at 17:08Z (7 real grants.gov figures + 3 evidenced denials),
-- and the ordinary crawl cycle re-upserted those same rows minutes later
-- (17:09-17:22Z) through crawlerOsPersistence, whose ON CONFLICT clause wrote
-- `amount_min = excluded.amount_min` — silence clobbering a learned answer
-- (the invariant-133 / #950 wipe class). The figures vanished while each row
-- stayed BURNED as answered, with `amount_enrich_last_reason` still naming
-- the success. The code fix adds the COALESCE never-wipe guards to that
-- bridge; per the migration-135 rule the permanent one-shot mark re-opens
-- when its premise was wiped out from under it.
--
-- Scope is exact and provable: a last_reason that is only ever written when
-- an answer WAS persisted (adapter success or evidenced denial), on a row
-- that now carries NO answer — that combination exists only where the answer
-- was destroyed after the fact. Idempotent; the reason breadcrumb survives.
UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND amount_enrich_last_reason IN (
        'grants_gov_api', 'sam_fal_api', 'federal_register_api',
        'no_award_amount_published', 'no_per_award_amount_in_document',
        'no_per_award_amount_in_listing', 'no_per_award_amount_on_page'
   )
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '');

UPDATE grants
   SET amount_enrich_attempted_at = NULL
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND amount_enrich_last_reason IN (
        'grants_gov_api', 'sam_fal_api', 'federal_register_api',
        'no_award_amount_published', 'no_per_award_amount_in_document',
        'no_per_award_amount_in_listing', 'no_per_award_amount_on_page'
   )
   AND COALESCE(amount_requested, 0) <= 0
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '');
