-- Repair five rotted org URLs in the amount census (verified live 2026-07-26).
-- Twin: postgres migration 0162_repair_rotted_org_urls.sql.
--
-- WHY. Five census rows point at pages that no longer exist where the crawler
-- stored them — two on domains that were WRONG or died (pacfcf.org is a
-- letter-transposition of the real paccf.org; 1stresponderchildren.org never
-- was the First Responders Children's Foundation's domain, which is
-- 1strcf.org), three on sites that restructured (hslda.org, thekf.org,
-- rhat.org). The dead-URL repair net's domain-pinned search cannot fix the
-- wrong-domain class (the true page is on a DIFFERENT domain — exactly the
-- cross-domain judgment reserved for a human), so this is the human's
-- verified hand-repair, same posture as migration 157.
--
-- EVERY replacement was verified TODAY: HTTP 200 on the org's own site with
-- the right page title, AND readable from the prod container (Railway egress):
--   1strcf.org/scholarship/  paccf.org/  rhat.org/awards
--   hslda.org/explore/grants-for-homeschooling (the site's own redirect target)
--   thekf.org/scholarship/tuition-scholarships/
-- clevelandstatecc.edu is deliberately NOT touched: the whole domain answers
-- 403 to every non-browser client and no alternate portal exists — that row's
-- honest state is unreadable until their WAF or a real portal changes.
--
-- Enrich state resets only on answerless rows (a new URL is a new claim —
-- the migration-135 rule).

-- ── First Responders Children's Foundation (wrong domain → 1strcf.org) ─────
UPDATE grants SET url = 'https://1strcf.org/scholarship/'
 WHERE COALESCE(url, '') LIKE '%1stresponderchildren.org%';
UPDATE grants SET application_url = 'https://1strcf.org/scholarship/'
 WHERE COALESCE(application_url, '') LIKE '%1stresponderchildren.org%';
UPDATE funding_opportunities SET source_url = 'https://1strcf.org/scholarship/'
 WHERE COALESCE(source_url, '') LIKE '%1stresponderchildren.org%';
UPDATE funding_opportunities SET application_url = 'https://1strcf.org/scholarship/'
 WHERE COALESCE(application_url, '') LIKE '%1stresponderchildren.org%';

-- ── Polish American Congress Charitable Foundation (typo domain → paccf.org) ─
UPDATE grants SET url = 'https://www.paccf.org/'
 WHERE COALESCE(url, '') LIKE '%pacfcf.org%';
UPDATE grants SET application_url = 'https://www.paccf.org/'
 WHERE COALESCE(application_url, '') LIKE '%pacfcf.org%';
UPDATE funding_opportunities SET source_url = 'https://www.paccf.org/'
 WHERE COALESCE(source_url, '') LIKE '%pacfcf.org%';
UPDATE funding_opportunities SET application_url = 'https://www.paccf.org/'
 WHERE COALESCE(application_url, '') LIKE '%pacfcf.org%';

-- ── Kosciuszko Foundation (site restructure) ────────────────────────────────
UPDATE grants SET url = 'https://thekf.org/scholarship/tuition-scholarships/'
 WHERE COALESCE(url, '') LIKE '%thekf.org/kf/scholarships%';
UPDATE grants SET application_url = 'https://thekf.org/scholarship/tuition-scholarships/'
 WHERE COALESCE(application_url, '') LIKE '%thekf.org/kf/scholarships%';
UPDATE funding_opportunities SET source_url = 'https://thekf.org/scholarship/tuition-scholarships/'
 WHERE COALESCE(source_url, '') LIKE '%thekf.org/kf/scholarships%';
UPDATE funding_opportunities SET application_url = 'https://thekf.org/scholarship/tuition-scholarships/'
 WHERE COALESCE(application_url, '') LIKE '%thekf.org/kf/scholarships%';

-- ── Rural Health Association of TN (page moved) ─────────────────────────────
UPDATE grants SET url = 'https://www.rhat.org/awards'
 WHERE COALESCE(url, '') LIKE '%rhat.org/tennessee-rural-health-awards%';
UPDATE grants SET application_url = 'https://www.rhat.org/awards'
 WHERE COALESCE(application_url, '') LIKE '%rhat.org/tennessee-rural-health-awards%';
UPDATE funding_opportunities SET source_url = 'https://www.rhat.org/awards'
 WHERE COALESCE(source_url, '') LIKE '%rhat.org/tennessee-rural-health-awards%';
UPDATE funding_opportunities SET application_url = 'https://www.rhat.org/awards'
 WHERE COALESCE(application_url, '') LIKE '%rhat.org/tennessee-rural-health-awards%';

-- ── HSLDA Compassion Grants (site's own redirect target) ────────────────────
UPDATE grants SET url = 'https://hslda.org/explore/grants-for-homeschooling'
 WHERE COALESCE(url, '') LIKE '%hslda.org/compassion-grants%';
UPDATE grants SET application_url = 'https://hslda.org/explore/grants-for-homeschooling'
 WHERE COALESCE(application_url, '') LIKE '%hslda.org/compassion-grants%';
UPDATE funding_opportunities SET source_url = 'https://hslda.org/explore/grants-for-homeschooling'
 WHERE COALESCE(source_url, '') LIKE '%hslda.org/compassion-grants%';
UPDATE funding_opportunities SET application_url = 'https://hslda.org/explore/grants-for-homeschooling'
 WHERE COALESCE(application_url, '') LIKE '%hslda.org/compassion-grants%';

-- ── Re-open the enrich claim for repaired-but-still-answerless rows ─────────
UPDATE grants
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0,
       amount_enrich_env_attempts = 0,
       amount_enrich_last_reason = 'dead_url_repaired:org_url_rot'
 WHERE (COALESCE(url, application_url, '') LIKE '%1strcf.org%'
     OR COALESCE(url, application_url, '') LIKE '%paccf.org%'
     OR COALESCE(url, application_url, '') LIKE '%thekf.org/scholarship/%'
     OR COALESCE(url, application_url, '') LIKE '%rhat.org/awards%'
     OR COALESCE(url, application_url, '') LIKE '%hslda.org/explore/grants-for-homeschooling%')
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
       amount_enrich_last_reason = 'dead_url_repaired:org_url_rot'
 WHERE (COALESCE(source_url, application_url, '') LIKE '%1strcf.org%'
     OR COALESCE(source_url, application_url, '') LIKE '%paccf.org%'
     OR COALESCE(source_url, application_url, '') LIKE '%thekf.org/scholarship/%'
     OR COALESCE(source_url, application_url, '') LIKE '%rhat.org/awards%'
     OR COALESCE(source_url, application_url, '') LIKE '%hslda.org/explore/grants-for-homeschooling%')
   AND amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '');
