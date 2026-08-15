-- Give the rows grants.gov has RETIRED their honest answer back.
--
-- The amount adapter reported the fetchOpportunity response "There is no
-- record found for your search." as the failure `no_synopsis_or_forecast` — a
-- stable-class failure, so the sweep burned each row (amount_enrich_attempted_at
-- set) holding NO recorded answer. Those rows then sat permanently in the
-- census's `unanswered_unreadable` bucket, which reds the owner's morning
-- report and names API-adapter work — for records the adapter HAD asked about
-- and been definitively answered about (verified live 2026-08-15 on ids
-- 338441 / 355786 / 360509: HTTP 200, "Webservice Succeeds", errorMessages =
-- "There is no record found for your search." — the listing is retired).
--
-- The adapter now classifies that response as a READ (`grants_gov_record_retired`
-- → an evidenced none_published + an honest amount_text label). But a burn is
-- permanent by design, so the fix alone can never reach an already-burned row
-- (the migration-138 rule: a permanent one-shot mark is a claim about the ROW,
-- and a NEW strategy re-opens it). This reset un-burns exactly the rows the
-- old classification damaged so the next sweep records the honest answer.
--
-- Scope is deliberately narrow: only rows whose last recorded reason IS the
-- old misclassification and that still carry no amount and no answer status.
-- Rows with amounts, rows already answered, and every other source are
-- untouched. Idempotent: once re-swept, amount_status is set and the predicate
-- no longer matches.

UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0
 WHERE amount_enrich_last_reason = 'grants_gov_api_failed:no_synopsis_or_forecast'
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND amount_status IS NULL
   AND amount_text IS NULL;
