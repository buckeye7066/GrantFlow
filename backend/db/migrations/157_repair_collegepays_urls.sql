-- Repair the dead tn.gov/collegepays URL family (verified live 2026-07-26).
-- Twin: postgres migration 0161_repair_collegepays_urls.sql.
--
-- WHY. TSAC retired the entire tn.gov/collegepays section — every page moved
-- to collegefortn.org — and tn.gov additionally WAF-blocks Railway egress
-- (connection RST before HTTP), so 14 grants + 22 catalog rows sat with URLs
-- that can never be read from prod: the census's tn.gov ×8 unreadable
-- cluster, incl. the HOPE Aspire / STEP UP rows. The dead-URL repair boot net
-- cannot reach most of them (their burn reasons are RST/outage-class, not
-- 404-class, because prod never even saw the 404), so this is a one-time
-- verified hand-repair — the owner-approved "make them real and readable"
-- action of 2026-07-26.
--
-- EVERY target URL below was verified live TODAY (HTTP 200 on TSAC's own
-- collegefortn.org, correct page title, per-award figures present where
-- stated): step-up, aspire-award, tennessee-hope-scholarship-3,
-- tennessee-financial-aid/tennessee-student-assistance-award,
-- general-assembly-merit-scholarship, ned-mcwherter-scholars-program.
-- Pages WITHOUT a verified live replacement (hope-access-grant,
-- dependent-children, promise, tn-reconnect) are DELIBERATELY not touched.
-- collegefortn.org answers prod egress (HTTP 200 verified from the prod
-- container), so repaired rows are readable by the ordinary amount sweeps.
--
-- Enrich state resets ONLY on rows that are still answerless — a new URL is a
-- new claim (the migration-135 rule); a row already carrying an amount or an
-- honest label keeps its answer and only gains the working URL.

-- ── STEP UP ────────────────────────────────────────────────────────────────
UPDATE grants SET url = 'https://www.collegefortn.org/tennessee-step-up-scholarship/'
 WHERE COALESCE(url, '') LIKE '%tn.gov/collegepays%step-up%';
UPDATE grants SET application_url = 'https://www.collegefortn.org/tennessee-step-up-scholarship/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%step-up%';
UPDATE funding_opportunities SET source_url = 'https://www.collegefortn.org/tennessee-step-up-scholarship/'
 WHERE COALESCE(source_url, '') LIKE '%tn.gov/collegepays%step-up%';
UPDATE funding_opportunities SET application_url = 'https://www.collegefortn.org/tennessee-step-up-scholarship/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%step-up%';

-- ── Aspire (incl. the HOPE Aspire Award rows — the award IS the Aspire
--    supplement page on TSAC's new site) ────────────────────────────────────
UPDATE grants SET url = 'https://www.collegefortn.org/aspire-award/'
 WHERE COALESCE(url, '') LIKE '%tn.gov/collegepays%aspire%';
UPDATE grants SET application_url = 'https://www.collegefortn.org/aspire-award/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%aspire%';
UPDATE funding_opportunities SET source_url = 'https://www.collegefortn.org/aspire-award/'
 WHERE COALESCE(source_url, '') LIKE '%tn.gov/collegepays%aspire%';
UPDATE funding_opportunities SET application_url = 'https://www.collegefortn.org/aspire-award/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%aspire%';

-- ── HOPE Scholarship (aspire rows already remapped above; hope-access has no
--    verified replacement and is excluded) ─────────────────────────────────
UPDATE grants SET url = 'https://www.collegefortn.org/tennessee-hope-scholarship-3/'
 WHERE COALESCE(url, '') LIKE '%tn.gov/collegepays%hope%'
   AND COALESCE(url, '') NOT LIKE '%aspire%' AND COALESCE(url, '') NOT LIKE '%hope-access%';
UPDATE grants SET application_url = 'https://www.collegefortn.org/tennessee-hope-scholarship-3/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%hope%'
   AND COALESCE(application_url, '') NOT LIKE '%aspire%' AND COALESCE(application_url, '') NOT LIKE '%hope-access%';
UPDATE funding_opportunities SET source_url = 'https://www.collegefortn.org/tennessee-hope-scholarship-3/'
 WHERE COALESCE(source_url, '') LIKE '%tn.gov/collegepays%hope%'
   AND COALESCE(source_url, '') NOT LIKE '%aspire%' AND COALESCE(source_url, '') NOT LIKE '%hope-access%';
UPDATE funding_opportunities SET application_url = 'https://www.collegefortn.org/tennessee-hope-scholarship-3/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%hope%'
   AND COALESCE(application_url, '') NOT LIKE '%aspire%' AND COALESCE(application_url, '') NOT LIKE '%hope-access%';

-- ── Tennessee Student Assistance Award ─────────────────────────────────────
UPDATE grants SET url = 'https://www.collegefortn.org/tennessee-financial-aid/tennessee-student-assistance-award/'
 WHERE COALESCE(url, '') LIKE '%tn.gov/collegepays%student-assistance-awar%';
UPDATE grants SET application_url = 'https://www.collegefortn.org/tennessee-financial-aid/tennessee-student-assistance-award/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%student-assistance-awar%';
UPDATE funding_opportunities SET source_url = 'https://www.collegefortn.org/tennessee-financial-aid/tennessee-student-assistance-award/'
 WHERE COALESCE(source_url, '') LIKE '%tn.gov/collegepays%student-assistance-awar%';
UPDATE funding_opportunities SET application_url = 'https://www.collegefortn.org/tennessee-financial-aid/tennessee-student-assistance-award/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%student-assistance-awar%';

-- ── General Assembly Merit Scholarship ─────────────────────────────────────
UPDATE grants SET url = 'https://www.collegefortn.org/general-assembly-merit-scholarship/'
 WHERE COALESCE(url, '') LIKE '%tn.gov/collegepays%'
   AND (COALESCE(url, '') LIKE '%gams%' OR COALESCE(url, '') LIKE '%general-assembly-merit%');
UPDATE grants SET application_url = 'https://www.collegefortn.org/general-assembly-merit-scholarship/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%'
   AND (COALESCE(application_url, '') LIKE '%gams%' OR COALESCE(application_url, '') LIKE '%general-assembly-merit%');
UPDATE funding_opportunities SET source_url = 'https://www.collegefortn.org/general-assembly-merit-scholarship/'
 WHERE COALESCE(source_url, '') LIKE '%tn.gov/collegepays%'
   AND (COALESCE(source_url, '') LIKE '%gams%' OR COALESCE(source_url, '') LIKE '%general-assembly-merit%');
UPDATE funding_opportunities SET application_url = 'https://www.collegefortn.org/general-assembly-merit-scholarship/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%'
   AND (COALESCE(application_url, '') LIKE '%gams%' OR COALESCE(application_url, '') LIKE '%general-assembly-merit%');

-- ── Ned McWherter Scholars Program ─────────────────────────────────────────
UPDATE funding_opportunities SET source_url = 'https://www.collegefortn.org/ned-mcwherter-scholars-program/'
 WHERE COALESCE(source_url, '') LIKE '%tn.gov/collegepays%mcwherter%';
UPDATE funding_opportunities SET application_url = 'https://www.collegefortn.org/ned-mcwherter-scholars-program/'
 WHERE COALESCE(application_url, '') LIKE '%tn.gov/collegepays%mcwherter%';

-- ── Re-open the enrich claim for repaired-but-still-answerless rows ─────────
UPDATE grants
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0,
       amount_enrich_env_attempts = 0,
       amount_enrich_last_reason = 'dead_url_repaired:collegepays_moved'
 WHERE COALESCE(url, application_url, '') LIKE '%collegefortn.org%'
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
       amount_enrich_last_reason = 'dead_url_repaired:collegepays_moved'
 WHERE COALESCE(source_url, application_url, '') LIKE '%collegefortn.org%'
   AND amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '');

-- ── Golden-AMOUNT sentinels for the figures verified live on TSAC's own
--    pages today (STEP UP $2,850/sem ceiling; Aspire $750/sem supplement;
--    HOPE $2,850/sem jr-sr ceiling). Guards the Coca-Cola class: an extractor
--    grabbing a program appropriation instead of the per-award figure reds
--    Anya's report. Idempotent via the NOT LIKE guard. ─────────────────────
-- system_kv is boot-created on some fresh DBs; canonical shape (migrate.js:445).
CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
INSERT OR IGNORE INTO system_kv (key, value, updated_at)
VALUES ('golden_amount_expectations', '[]', CURRENT_TIMESTAMP);
UPDATE system_kv
   SET value = json_insert(
                 json_insert(
                   json_insert(value,
                     '$[#]', json('{"label":"Tennessee STEP UP Scholarship","url_contains":"collegefortn.org/tennessee-step-up","expect_max":2850,"over_factor":3,"under_factor":5}')),
                   '$[#]', json('{"label":"Aspire Award (HOPE supplement)","url_contains":"collegefortn.org/aspire-award","expect_max":750,"over_factor":4,"under_factor":5}')),
                 '$[#]', json('{"label":"Tennessee HOPE Scholarship","url_contains":"collegefortn.org/tennessee-hope-scholarship","expect_max":2850,"over_factor":3,"under_factor":5}')),
       updated_at = CURRENT_TIMESTAMP
 WHERE key = 'golden_amount_expectations'
   AND value NOT LIKE '%collegefortn.org/tennessee-step-up%';
