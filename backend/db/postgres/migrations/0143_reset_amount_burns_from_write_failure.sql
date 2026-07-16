-- Return the rows a BUG burned, holding nothing.
-- Twin of sqlite migration 139_reset_amount_burns_from_write_failure.sql.
--
-- 138/0142 un-burned the grants.gov rows so the new API adapter could read
-- them. It worked — the adapter resolved real award figures from the API on the
-- first boot. Then the write threw.
--
-- `funding_opportunities.amount_confidence` is REAL (0136/0140 era), and the
-- adapter shipped returning the STRING 'high'. SQLite is typeless so every unit
-- test passed; Postgres threw `invalid input syntax for type real: "high"`.
--
-- The sweep recorded the attempt BEFORE the write, so each row was already
-- marked permanently attempted when the UPDATE blew up. The catch logged
-- "non-fatal, will retry" — but the candidate query excludes marked rows, so
-- there was no retry, ever. 10 active-pipeline rows whose amounts grants.gov
-- had already returned were burned holding nothing while the log read green.
--
-- Both causes are fixed in the same PR as this migration (numeric
-- AMOUNT_CONFIDENCE_STRUCTURED; the mark now runs only after every write
-- succeeds). This repairs the rows they already damaged — the fix alone cannot,
-- because the burn is permanent by design.
--
-- Narrow + idempotent: grants.gov rows still carrying no dollar figure and no
-- amount_text. Rows with a value are untouched; no other source is touched.
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
