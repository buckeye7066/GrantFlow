-- Give the rows an API adapter can now read their chance back.
-- Twin of sqlite migration 138_reset_adapter_readable_amount_burns.sql.
--
-- 136/0140 + 137/0141 made the amount-enrichment sweep honest about WHEN to
-- permanently burn a row: burn once we have learned its answer, and a JS-shell
-- `thin_page` counts as learned ("this host renders client-side; it will be
-- thin every night"). Correct for a sweep whose ONLY strategy was fetching.
--
-- It stops being correct the moment a second strategy exists. Every grants.gov
-- row fetches to a JS shell, so the sweep burned them all as `thin_page` —
-- permanently, via the amount_enrich_attempted_at predicate — while grants.gov
-- publishes awardCeiling/awardFloor over a keyless JSON API the whole time.
-- Those rows were not unanswerable; they were being asked the wrong way.
-- grants.gov was 45 of the 149 remaining backlog rows (prod audit 2026-07-15):
-- the largest slice, and the slice the new adapter
-- (services/sources/grantsGovAmountAdapter.js) exists to read.
--
-- Without this reset the adapter ships and changes NOTHING — the sweep's
-- candidate query excludes attempted rows, so it would never hand the adapter a
-- row it was built for. That is the same "reads green while doing nothing"
-- class as #941's limit-before-filter and #944's unreachable retry guard.
--
-- Narrow by design: only grants.gov rows that still carry no dollar figure.
-- Rows with an amount are left alone; no other source is touched (their burns
-- were decided by a strategy that genuinely could read them). Idempotent.
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
