-- (Postgres twin of sqlite migration 168.)
-- Migration 167 shipped with a predicate that could not match its own targets.
--
-- 167 un-burns the rows the old `grants_gov_api_failed:no_synopsis_or_forecast`
-- misclassification damaged (the API's real answer was "There is no record
-- found for your search" — the listing is retired). Its predicate required
-- `amount_status IS NULL` — but `enforceGrantAmountBackfill`'s labeling step
-- stamps truly amount-less catalog rows `'not_listed'`, and every one of the
-- six live prod rows carried exactly that. `not_listed` is SILENCE (the honest
-- default; the census counts it unanswered), not an answer — so requiring NULL
-- excluded the entire target set, and 167 ran in prod repairing zero rows.
--
-- The verification compounding it: the post-deploy probe used the SAME
-- too-narrow predicate, so it read "0 still burned" — a check that could not
-- fail (the exact class the verify-your-verification rule exists for).
-- Verified live 2026-08-15 15:5xZ: row bdbdba0b-… still burned, attempted_at
-- 08:36Z, amount_status 'not_listed'.
--
-- Same scope discipline as 167, with the corrected answer predicate: only the
-- misclassified-reason rows that still carry NO amount and NO real answer.
-- `'not_listed'` is included because it is the unanswered default; every REAL
-- answer status (none_published/varies/contact_required/estimated/known/range)
-- still protects its row. Idempotent: once the new adapter answers, the row
-- carries none_published + amount_text and leaves the predicate.

UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0
 WHERE amount_enrich_last_reason = 'grants_gov_api_failed:no_synopsis_or_forecast'
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND amount_text IS NULL;
