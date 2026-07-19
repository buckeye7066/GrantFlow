-- Give the SILENT-burned amount rows one fresh read.
-- Twin: postgres migration 0147_reset_silent_amount_burns_for_reread.sql.
--
-- The 5th un-burn in this subsystem (cf. 138/139/140/141), and the safest: it
-- resets rows that were marked attempted but NEVER recorded an answer — status
-- still `not_listed` (silence), no amount, no amount_text. Those were burned as a
-- JS-shell `thin_page` or after a TRANSIENT fetch failure exhausted its retries
-- (a network hiccup during a bulk drain, an overloaded host). Two things changed
-- that make a re-read worth one attempt:
--   * PR #958 taught the extractor to skip program TOTALS ("200 stipends up to
--     $237,500 annually", "annual scholarships of $3.55M") and return the real
--     per-award figure. Pages that returned a wrong-or-no amount now read
--     correctly (Coca-Cola $237,500 → $20,000, verified live).
--   * The transient-burned rows never got a real answer at all.
--
-- HONEST EXPECTED YIELD: PARTIAL. A genuine client-rendered shell (studentaid.gov
-- FAFSA/Pell, sam.gov, tenncareconnect) will read thin AGAIN and re-burn — that
-- is correct and costs one bounded fetch. The HTML scholarship/foundation pages
-- (hsf, elks, community foundations) read fine now and will land a real amount or
-- an evidenced `none_published`. This buys a re-read, not a guarantee.
--
-- NARROW + IDEMPOTENT: only rows that are amount-less AND silent (never answered)
-- AND have a URL to read are reset. A row that carries an amount, real
-- amount_text, or an honest status (`none_published`/`varies`/`contact_required`)
-- is UNTOUCHED — a real answer is never thrown away. `amount_enrich_attempts` is
-- reset to 0 so MAX_ATTEMPTS starts fresh; a permanently-dead host still settles
-- after 3 nights. Re-running is a no-op once the sweep records an answer.
--
-- Two writers, two columns:
--   funding_opportunities.amount_enrich_attempted_at (catalog sweep)
--   grants.amount_enrich_attempted_at                (orphan direct-read sweep, 142)

UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND amount_text IS NULL
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND COALESCE(source_url, application_url, evidence_url) IS NOT NULL
   AND id IN (
     SELECT fo.id
       FROM funding_opportunities fo
       JOIN grants g ON g.funding_opportunity_id = fo.id
      WHERE g.status IN (
        'discovery', 'discovered', 'interested', 'auto_applied', 'drafting',
        'application_prep', 'app_prep', 'revision', 'portal', 'submitted',
        'pending_review', 'under_review', 'follow_up', 'report'
      )
   );

UPDATE grants
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND funding_opportunity_id IS NULL
   AND COALESCE(amount_requested, 0) <= 0
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_text IS NULL OR amount_text = '')
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND COALESCE(url, application_url) IS NOT NULL
   AND status IN (
     'discovery', 'discovered', 'interested', 'auto_applied', 'drafting',
     'application_prep', 'app_prep', 'revision', 'portal', 'submitted',
     'pending_review', 'under_review', 'follow_up', 'report'
   );
