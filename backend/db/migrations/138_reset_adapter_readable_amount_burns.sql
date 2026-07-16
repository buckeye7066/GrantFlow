-- Give the rows an API adapter can now read their chance back.
--
-- 136/137 made the amount-enrichment sweep honest about WHEN to permanently
-- burn a row: a row is burned once we have learned its answer, and a JS-shell
-- `thin_page` counts as learned ("this host renders client-side; it will be
-- thin every night, so stop asking"). That reasoning was correct for a sweep
-- whose ONLY strategy was fetching the page.
--
-- It stops being correct the moment a second strategy exists. grants.gov is the
-- exact case: every one of its rows fetches to a JS shell, so the sweep burned
-- them all as `thin_page` — permanently, via the amount_enrich_attempted_at
-- predicate — while grants.gov publishes awardCeiling/awardFloor over a keyless
-- JSON API the whole time. Those rows were not unanswerable; they were being
-- asked the wrong way. grants.gov was 45 of the 149 remaining backlog rows in
-- the 2026-07-15 prod audit: the single largest slice, and the slice the new
-- adapter (services/sources/grantsGovAmountAdapter.js) exists to read.
--
-- Without this reset the adapter would ship and change NOTHING: the sweep's
-- candidate query excludes `amount_enrich_attempted_at IS NOT NULL`, so it
-- would never hand the adapter a single row it was built for — a fix reading
-- green while doing nothing, which is the exact class of defect (#941's
-- limit-before-filter, #944's unreachable retry guard) this subsystem has now
-- produced twice.
--
-- Scope is deliberately narrow: only rows that are grants.gov AND still carry
-- no dollar figure. A row that already has an amount is left alone (nothing to
-- gain), and no other source is touched (their burns were decided by a strategy
-- that genuinely could read them). Resetting attempts to 0 as well is correct:
-- the attempt budget exists to stop us re-fetching a dead host forever, and
-- these rows have never been tried by the strategy that can actually answer
-- them. This is idempotent-safe to re-run.
--
-- GENERALIZE: when a new strategy makes previously-unreadable rows readable,
-- the rows it can now read must be un-burned in the same PR. A permanent
-- one-shot mark is a claim about the ROW ("we know its answer"), not about the
-- strategy — so when the strategy changes, the claim has to be re-examined.
UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (
        LOWER(COALESCE(source, '')) IN ('grants.gov', 'grants_gov')
     OR LOWER(COALESCE(record_origin, '')) = 'grants_gov'
     OR LOWER(COALESCE(source_url, '')) LIKE '%grants.gov/%'
     OR LOWER(COALESCE(application_url, '')) LIKE '%grants.gov/%'
   );
