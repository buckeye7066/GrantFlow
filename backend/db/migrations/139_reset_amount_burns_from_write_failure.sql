-- Return the rows a BUG burned, holding nothing.
--
-- 138/0142 un-burned the grants.gov rows so the new API adapter could read
-- them. It worked: the adapter resolved real award figures from the API on the
-- first boot. Then the write threw.
--
-- `funding_opportunities.amount_confidence` is a REAL column, and the adapter
-- shipped returning the STRING 'high' for it. SQLite is typeless, so every unit
-- test passed; Postgres is not, and threw:
--
--     invalid input syntax for type real: "high"
--
-- The sweep recorded the attempt BEFORE the write, so each row was already
-- marked permanently attempted when the UPDATE blew up. The catch block logged
-- "non-fatal, will retry" — but the candidate query excludes marked rows, so
-- there was no retry, ever. 10 active-pipeline rows whose amounts grants.gov
-- had ALREADY returned were burned holding nothing, and the log said it was
-- fine. (Same shape as #944: a comforting message on an unreachable path.)
--
-- Both causes are fixed in the same PR as this migration — the adapter now
-- returns AMOUNT_CONFIDENCE_STRUCTURED (numeric), and the sweep records the
-- attempt only after every write SUCCEEDS, so "will retry" is now true. This
-- migration repairs the rows those bugs already damaged, since the fix alone
-- cannot: the burn is permanent by design.
--
-- Scope: the same narrow predicate as 138 — grants.gov rows still carrying no
-- dollar figure. A row that has an amount is left alone, and no other source is
-- touched. Idempotent.
--
-- GENERALIZE: a permanent mark must be written only for an outcome that was
-- actually PERSISTED. "We tried" is not "we learned", and a retry guard that
-- sits after the thing it guards is decoration — this subsystem has now proven
-- that twice (#944's unreachable catch, and this).
UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND amount_text IS NULL
   AND (
        LOWER(COALESCE(source, '')) IN ('grants.gov', 'grants_gov')
     OR LOWER(COALESCE(record_origin, '')) = 'grants_gov'
     OR LOWER(COALESCE(source_url, '')) LIKE '%grants.gov/%'
     OR LOWER(COALESCE(application_url, '')) LIKE '%grants.gov/%'
   );
