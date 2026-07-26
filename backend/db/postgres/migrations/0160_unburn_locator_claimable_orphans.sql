-- Un-burn answerless ORPHAN grants the locator classifier can now CLAIM (9th un-burn).
-- Twin: sqlite migration 156_unburn_locator_claimable_orphans.sql.
--
-- WHY. Caught live 2026-07-26: 3 studentaid.gov orphan grants (FAFSA, Pell,
-- COA appeal) sat in the census's `unanswered_unreadable` bucket even though
-- studentaid.gov entered BENEFIT_HOSTS (locatorUrlKind.js) in fix-cycle-3 on
-- 2026-07-22 — because they were burned on 2026-07-17, five days BEFORE the
-- rule existed, and the only code that can apply a structural claim to an
-- ORPHAN grant is enforceGrantDirectAmountEnrichment's short-circuit, whose
-- candidate query excludes burned rows (`amount_enrich_attempted_at IS NULL`).
-- The migration-135 rule verbatim: a permanent one-shot mark is a claim about
-- the ROW, so a NEW strategy re-opens it. Migrations 138/152 did this when the
-- API adapters shipped; no twin was shipped when the locator host rules grew.
--
-- SCOPE, narrow and provable (the 152 adversarial-gate posture): only rows the
-- structural classifier makes a POSITIVE claim about — the effective URL the
-- sweep itself classifies (url, else application_url: the sweep passes
-- `g.url ?? g.application_url` as source_url and classifyLocatorKindFromRow
-- reads ONLY that slot when present) matches a LOCATOR_URL_LIKE_PREFILTERS
-- shape. The claim is answered WITHOUT any fetch (benefit → 'varies',
-- directory → honest label), so re-opening these can never re-spend fetch
-- budget on a doomed host. A LIKE over-match is decided by the real classifier
-- at sweep time and at worst costs that row its ordinary bounded re-read.
-- Orphans only (`funding_opportunity_id IS NULL`): a LINKED grant's kind is
-- classified on its catalog row by the locator_kind_classification boot sweep,
-- which never looks at burn marks — linked rows need no un-burn to converge.
-- Only the one-shot mark is reset; a row carrying any recorded answer is
-- untouched; `amount_enrich_attempts` is preserved so MAX_ATTEMPTS still
-- bounds a genuinely broken host. Idempotent: a claimed row gains
-- amount_status/amount_text and leaves this predicate for good.
UPDATE grants
   SET amount_enrich_attempted_at = NULL
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND funding_opportunity_id IS NULL
   AND COALESCE(amount_requested, 0) <= 0
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND (amount_status IS NULL OR amount_status = 'not_listed')
   AND (amount_text IS NULL OR amount_text = '')
   AND (
        COALESCE(url, application_url, '') LIKE '%sam.gov/fal/%' OR
        COALESCE(url, application_url, '') LIKE '%ssa.gov/survivor%' OR
        COALESCE(url, application_url, '') LIKE '%ssa.gov/disability%' OR
        COALESCE(url, application_url, '') LIKE '%ssa.gov/ssi%' OR
        COALESCE(url, application_url, '') LIKE '%ssa.gov/retirement%' OR
        COALESCE(url, application_url, '') LIKE '%ssa.gov/benefits%' OR
        COALESCE(url, application_url, '') LIKE '%ssa.gov/medicare%' OR
        COALESCE(url, application_url, '') LIKE '%studentaid.gov/%' OR
        COALESCE(url, application_url, '') LIKE '%tenncareconnect.tn.gov/%' OR
        COALESCE(url, application_url, '') LIKE '%fabenefits.dhs.tn.gov/%' OR
        COALESCE(url, application_url, '') LIKE '%tn211.org/%' OR
        COALESCE(url, application_url, '') LIKE '%benefitscheckup.org/%' OR
        COALESCE(url, application_url, '') LIKE '%projects.propublica.org/nonprofits/organizations/%' OR
        COALESCE(url, application_url, '') LIKE '%scholarships.com/financial-aid/college-scholarships/%scholarships-by-%'
   );
