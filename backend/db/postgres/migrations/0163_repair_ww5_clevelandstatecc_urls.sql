-- Repair the dead ww5.clevelandstatecc.edu host (Anya report 2026-07-27:
-- `unanswered_unreadable` top host). Twin: sqlite 159_repair_ww5_clevelandstatecc_urls.sql.
--
-- WHY. The host stopped answering entirely — TCP connect to :443 times out
-- from BOTH local and the prod container (verified 2026-07-27), so no fetch
-- strategy can ever read it. The content ("Cleveland State Community College
-- Foundation Scholarships") lives on the Foundation's own NextGen portal,
-- which IS readable from prod egress (HTTP 200 with real award copy, verified
-- from the Railway container 2026-07-27). www.clevelandstatecc.edu itself
-- stays untouched: migration 158's finding holds (the college's site answers
-- non-browser clients with a WAF challenge — an HTTP 202 interstitial today).
--
-- The portal is a multi-award LISTING page, so the amount read goes through
-- the title-anchored listing_page adapter
-- (services/sources/listingPageAmountAdapter.js), never whole-page extraction
-- — a sibling scholarship's figure must not be misattributed to these rows.
--
-- Enrich state resets only on answerless rows (a new URL is a new claim —
-- the migration-135 rule).

UPDATE grants SET url = 'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search'
 WHERE COALESCE(url, '') LIKE '%ww5.clevelandstatecc.edu%';
UPDATE grants SET application_url = 'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search'
 WHERE COALESCE(application_url, '') LIKE '%ww5.clevelandstatecc.edu%';
UPDATE funding_opportunities SET source_url = 'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search'
 WHERE COALESCE(source_url, '') LIKE '%ww5.clevelandstatecc.edu%';
UPDATE funding_opportunities SET application_url = 'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search'
 WHERE COALESCE(application_url, '') LIKE '%ww5.clevelandstatecc.edu%';
UPDATE funding_opportunities SET evidence_url = 'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search'
 WHERE COALESCE(evidence_url, '') LIKE '%ww5.clevelandstatecc.edu%';

-- ── Re-open the enrich claim for repaired-but-still-answerless rows ─────────
UPDATE grants
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0,
       amount_enrich_env_attempts = 0,
       amount_enrich_last_reason = 'dead_url_repaired:ww5_host_dead'
 WHERE COALESCE(url, application_url, '') LIKE '%clevelandstatecc.scholarships.ngwebsolutions.com%'
   AND amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_requested, 0) <= 0
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '');
UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0,
       amount_enrich_env_attempts = 0,
       amount_enrich_last_reason = 'dead_url_repaired:ww5_host_dead'
 WHERE COALESCE(source_url, application_url, '') LIKE '%clevelandstatecc.scholarships.ngwebsolutions.com%'
   AND amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '');
