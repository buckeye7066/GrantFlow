-- Give back the rows that were burned WITHOUT a recorded answer.
-- Twin: postgres migration 0145_reset_amount_burns_with_no_recorded_answer.sql.
--
-- The fourth instance of this subsystem's signature class, and the same shape
-- every time: a permanent one-shot mark is a claim about the ROW ("we know its
-- answer"), never about the strategy that happened to be current when it was
-- set. When the rule changes, the rows burned under the old rule must be
-- re-opened IN THE SAME PR — otherwise the fix reads green while doing nothing
-- (138/0142 un-burned adapter-readable rows; 139/0143 the write-failure rows;
-- 140/0144 the rows a re-crawl wiped).
--
-- Two populations are burned today on evidence that does not exist:
--
-- 1. THE PRE-#944 UNCONDITIONAL BURNS. Before #944 the sweep marked every row it
--    touched, with the retry rule sitting in a catch block that a service
--    documented "never throws" could not reach. So an outage burned rows it
--    never read. In prod these are exactly identifiable: `amount_enrich_attempts`
--    is 0 while `amount_enrich_attempted_at` is set — the current sweep always
--    writes `attempts = attempts + 1` alongside the mark, so attempts=0 proves
--    the mark predates the evidence rule. Measured 2026-07-17: 28 rows, ALL
--    stamped 2026-07-15 (the date #944's memo records as "30 rows marked, 0
--    amounts, 0 retried"), every one still holding a usable URL and no
--    amount_text — i.e. rows today's sweep would happily take.
--
-- 2. THE ANSWERS NOBODY WROTE DOWN. Until this PR the sweep learned, at real
--    fetch cost, whether a funder publishes a per-award figure — and then threw
--    that answer away. Its write branch only persisted a status when the status
--    was NOT 'not_listed', which is precisely the value the extractor returns
--    for "read the page, no figure here". So a row that was read and honestly
--    denied looks IDENTICAL to a row nothing ever looked at: blank, burned,
--    unexplained. `none_published` now records that denial — but a status can
--    only be written for a row the sweep is allowed to re-read.
--
-- Both are re-opened by the same narrow predicate: an active-pipeline row that
-- is burned, still carries no dollar figure and no amount text, has a URL to
-- read, and carries NO recorded answer (status is silence — NULL or the
-- extractor's 'not_listed' default). A row with an amount, with real amount
-- text, or with an honest status ('varies', 'contact_required', and now
-- 'none_published') is untouched, so re-running this cannot undo real evidence.
-- Idempotent: once the sweep re-reads a row it records an answer, which takes
-- the row out of this predicate permanently.
--
-- `amount_enrich_attempts` is deliberately NOT reset: MAX_ATTEMPTS still bounds
-- a permanently-broken host, so this hands back a chance, not an infinite one.
--
-- HONEST EXPECTED YIELD: LOW. These rows are dominated by benefit programs and
-- locators (SSI, CoverKids, food-bank finders) that genuinely publish no
-- per-award figure, so most will be re-read and re-burned — this time carrying
-- `none_published`, which is the entire point. This migration buys EVIDENCE,
-- not coverage. Anyone expecting the coverage number to jump is expecting the
-- wrong thing (the same warning #944 shipped, and it was right).
UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL
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
