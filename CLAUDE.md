# CLAUDE.md — GrantFlow

Guidance for Claude Code (and human contributors) working in this repo.

## Live-editing lock (multi-agent coordination)

This repo is sometimes worked on by more than one assistant at once (a Claude
Code session AND Cursor's agent share the same working tree). Concurrent
autonomous writes entangle diffs and produce surprise commits.

**If a file named `.agent-edit-lock` exists at the repo root**, a human and
another assistant are actively editing right now. Unless you are the session
that created the lock, you MUST NOT edit/create/delete files, commit, or push —
do read-only work only and tell the user the repo is locked. This suspends any
"auto-push fixes" / "optimize continuously" standing instructions while the lock
is present. The lock is git-ignored; remove it (`rm .agent-edit-lock`) to
release. (Cursor honors the same lock via `.cursor/rules/respect-edit-lock.mdc`.)

## Commands

```bash
npm run dev          # Vite frontend dev server
npm run backend      # Express backend only
npm run dev:full     # Both frontend & backend (concurrently)

npm run build        # Production build
npm run lint         # ESLint (zero warnings enforced)
npm run typecheck    # TypeScript check
npm run unit         # Vitest unit tests
npm run test         # profile-metadata check + lint:ci + typecheck + build + unit
npm run test:all     # + smoke + e2e (Playwright)
npm run check:prepush  # Pre-push guardrail chain (auth-middleware/profile-guards/profile-metadata/runtime-imports/env-examples checks + lint + typecheck + build)

npm run migrate      # Run DB migrations
npm run db:setup     # migrate + seed
npm run doctor       # Project health check

npm run crawler-os:crawl              # Run crawler-os discovery
npm run crawler-os:test               # crawler-os node:test suite
npm run crawler:doctor                # Crawler-os health diagnostics
npm run crawler:verify                # End-to-end crawler system verify
npm run opps:ensure-national-minimum  # Ensure national opportunity floor
```

## Architecture

- **Frontend** (`src/`): React 18 + Vite + TypeScript + Tailwind + Radix UI. State via Zustand (`stores/`). Feature-based components under `components/`. API calls go through `api/`.
- **Backend** (`backend/`): Express, ~100 route files under `backend/routes/`, business logic in `backend/services/`, DB access via `backend/db/`. Entry: `backend/server.js`. Boot tasks in `backend/startup/`.
- **Shared + vnext**: `shared/` holds ~16 cross-cutting modules (`pipelineStages.js`, `dedupePipelineGrants.js`, `opportunityFundability.js`, etc.); `backend/vnext/` holds the newer scoring/state-machine subsystem (`scoringService.js`, `stateMachine.js`).
- **Crawler-os agents**: anya, hamilton, john, robert, sam, yana under `backend/crawler-os/agents/`; Amy lives in `backend/services/amy/`.
- **AI**: Claude (`@anthropic-ai/sdk`) + OpenAI for drafting, discovery, and the "Anya" assistant. Prompts in `backend/prompts/`.
- **Recall/grounding/critic lanes (flag-gated, default OFF)**: `SEMANTIC_RECALL` (embedding recall booster — ADDITIVE candidates only; `backend/services/embeddings/embeddingService.js`; matchEngine stays the sole decision authority), `COMPARABLE_AWARDS` (real NIH RePORTER awards as labeled reference-only drafting context), `PROPOSAL_CRITIC` (multi-pass draft critic). Contracts + off-state behavior: `docs/canonical_rules.md` ("Feature flags" section).
- **DB**: SQLite for local/test (`backend/db/schema.sql`), Postgres in prod via a shim. Tests use vitest with `.js` (`backend/tests/`); a few runners use `node:test` with `.mjs` — match the convention of the file you're editing.
- **Deployment**: Frontend → Vercel, Backend → Railway (PostgreSQL).
- **Canonical product rules + goals**: `docs/canonical_rules.md` is the single source of truth. Read it before changing matching, discovery, pipeline, or tenancy behavior.

## MIGRATION PARITY — superseding a system requires proving coverage, not just cutover

The 2026-07 crawler-os cutover silently stranded 12+ discovery lanes: the
migration verified the OLD paths stopped running (superseded job types) but
never enumerated what those paths could REACH and asserted the new system
reached it too. The standing rule:

> A PR that supersedes/replaces a subsystem MUST ship a mechanical parity
> check: enumerate the old system's reachable surface (sources, job types,
> domains, fields — whatever the unit is) in a test or script, and assert the
> replacement covers every item or explicitly lists each exclusion with a
> reason. "The old code no longer runs" is not evidence of parity.

Companion rule for enumerable inventories: any set whose members live in more
than one place (sources ↔ adapters ↔ dashboard lanes; thresholds ↔ display
tiers; profile facts ↔ question fields) gets a REGISTRY plus a TOTALITY test
so a new member cannot silently fall out of any consumer (precedents:
`LANE_OF_SOURCE` totality in `coverageEvidenceService.test.js`,
`check-env-examples`, `profileKnownFacts` field-map guard).

Owner-verified outcomes on real profiles are protected by the
**golden-outcome sentinel** (`coverage.goldenOutcomes` in
`backend/services/sam/samRegistry.js`, expectations in `system_kv
golden_outcome_expectations`): after live-verifying a coverage fix, append the
expectation so a future regression reds Anya's morning report instead of
waiting for the owner to notice.

## INVARIANTS — enforce at a choke point, never trust per-call discipline

GrantFlow's recurring bugs came from canonical RULES being enforced only by
convention ("remember to check X in every code path"). The standing rule:

> A machine-checkable product rule must be re-asserted in ONE place against the
> live DB, so it holds regardless of which code path created the data. The
> per-call gate is the first line of defense; the boot sweep is the net. Do NOT
> scatter new ad-hoc checks across call sites.

**The single enforcer is `backend/startup/enforceInvariants.js`**, run on every
boot from `backend/server.js` immediately after `ensureSchemaInvariants()`. The
full `runSelfHeal()` orchestrator in `backend/startup/selfHeal.js` also calls it
as step 9 for Sam/Anya on-demand and maintenance runs, but boot wires the
invariant sweep directly so it cannot be skipped by self-heal schedule changes.
It mirrors `backend/startup/ensureSchemaInvariants.js` (which owns schema-shape
DDL; data-repair invariants go in `enforceInvariants.js`).

When you add or change behavior that touches an invariant below, change the
enforcer + its test — do not rely on a new per-call check alone.

| Invariant | Single enforcer | Guard test |
| --- | --- | --- |
| Sticky deletes (deleted pipeline grants stay gone) | `reconcileDismissedGrants()` in `backend/services/pipelineDismissals.js`, re-run by `enforceStickyDeletes()` | `backend/tests/enforceInvariants.test.js` |
| No cross-profile / cross-tenant bleed (grant org must match its profile's org) | `enforceNoCrossProfileBleed()` | `backend/tests/enforceInvariants.test.js` |
| Relevance / match-score floor (no junk in pipeline; `match_score < 5` on the DATA-POINT scale, excl. NULL — see `backend/config/matchThresholds.js` for the 2026-07-06-evening scale where score = matched profile data points ÷ total data points × eligibility × geo gates, 8 is the pipeline bar, and bands were empirically calibrated against the prod distribution) | `enforceRelevanceFloor()` (ON by default; `ENFORCE_RELEVANCE_FLOOR=0` for count-only) | `backend/tests/enforceInvariants.test.js` |
| Pipeline grants belong to a profile (no orphan `profile_id IS NULL` rows leaking into org-scoped reads/PDFs) | `enforceProfileScopedPipeline()` (ON by default; preserves `amount_awarded > 0`; disable via `ENFORCE_PROFILE_SCOPED_PIPELINE=0`) | `backend/tests/enforceInvariants.test.js` |
| One canonical income per **individual** profile (conflicting `household_income` across the `financial` vs `financial_information` sections must not poison need-based matching) | `enforceProfileIncomeReconciliation()` — for INDIVIDUAL/student/family/veteran profiles only, collapses a conflict to the applicant's own (need-consistent / **lower**) income and syncs both sections; orgs/businesses are never touched; an ambiguous conflict with no need signal is **logged for human review, not changed**. Read-only audit: `backend/scripts/audit-profile-income-conflicts.mjs` | `backend/tests/enforceInvariants.test.js` |
| A person-type profile (individual/family/student/veteran) never carries a contradicted org identity (a bad Base44/AI-enrichment import can hallucinate `organization_details.organization_type`/`small_business_details.business_name` onto an individual, which `resolveEffectiveProfileType()` then treats as MORE specific than `primary_type` and promotes the whole profile — and its match `applicant_types` — to an org, surfacing institutional RFPs instead of individual-benefit programs: the Kimberly Botts class) | `enforceIndividualOrgSectionConflict()` — clears `organization_type`/`business_name` ONLY when the profile's own `occupation` section already structurally denies both (`nonprofit_employee=false` AND `small_business_owner=false`); orgs are never touched; no structured denial = **logged for human review, not changed** (the profile may legitimately run both) | `backend/tests/enforceInvariants.test.js` |
| No search-engine application targets (a `google.com/search?q=…` / other search-RESULTS url is never a portal/application URL on `application_tasks`, `funding_opportunities`, or `grants`) | `enforceNoSearchEngineApplicationTargets()` (nulls the URL; reclassifies non-terminal tasks to blocked/`unknown_application_method`; bounded + idempotent; disable via `ENFORCE_URL_HYGIENE=0`). Producers gated at `opportunityInserter.upsertFundingOpportunity` + `hamiltonAutomationClassifier.readUrl` via the canonical `isSearchEngineUrl()` (`backend/config/urlRules.js`) | `backend/tests/enforceInvariants.test.js` |
| Pipeline grants carry the funder's name when knowable (`grants.funder` ← linked `funding_opportunities.sponsor`; the catalog column is `sponsor`, the pipeline column is `funder` — #725 naming-drift class) | `enforceFunderBackfill()` — re-copies the sponsor from the linked opportunity; NEVER invents a value (unlinked/empty-sponsor rows are counted as `missingFunder`, not guessed). Ingest-side first line of defense: `resolveSponsorName()` in `backend/services/opportunityInserter.js` accepts `funder`/`funder_name`/`organization`/`agency` aliases into `sponsor` | `backend/tests/enforceInvariants.test.js` + static tripwire `backend/tests/funderFieldDrift.test.js` |
| No dangling profile-opportunity matches (a surfaced match must point at a catalog row that still exists — ghosts inflate the matches view and fail promote passes with `opportunity_not_found`; catalog purge paths never cleaned matches up) | `enforceNoDanglingMatches()` — deletes match rows whose `opportunity_id` no longer resolves; disable via `ENFORCE_NO_DANGLING_MATCHES=0` | `backend/tests/enforceInvariants.test.js` |
| Pipeline grants carry a DOLLAR value when one is knowable (every "Pipeline $" surface reads the `backend/config/pipelineValue.js` choke point: `amount_requested` → `amount_max` → `amount_min`; never re-inline a status list or `SUM(amount_requested)` — the "$6,500 pipeline with 118 real sources" class). "$0" and "no amount stated" are DIFFERENT facts: dollar cards must also render `unvaluedCountSql()`'s count ("+N sources without listed amounts") so benefit programs/directories don't read as "qualifies for nothing" | `enforceGrantAmountBackfill()` — inherits `amount_min/max` from the linked catalog row, defaults `amount_requested` from the ceiling/floor; NEVER invents a value (`missingAmount` counted, not guessed). Write-side first line of defense: `saveToProfilePipeline` defaults `amount_requested`; ingest-side: `resolveOpportunityAmounts()` (`backend/services/awardAmountExtractor.js`) conservatively extracts per-award dollars from text when a source provides no structured amounts. Runs BEFORE `enforceIndividualAmountCeiling` so the ceiling purges on honest values | `backend/tests/enforceInvariants.test.js` + `backend/tests/pipelineValue.test.js` + `backend/tests/awardAmountExtractor.test.js` |
| Every pipeline grant carries a match score when computable (an unscored NULL row must not masquerade as an engine-endorsed match — the Eileen-Fisher-on-a-church class) | `enforceGrantScoreBackfill()` — canonical re-score of NULL-score rows against their own profile, bounded per boot (`SCORE_BACKFILL_BATCH`, default 300); disable via `ENFORCE_GRANT_SCORE_BACKFILL=0`. UI first line of defense: "Not scored" badge on NULL-score cards (`src/components/pipeline/GrantCard.jsx`) | `backend/tests/enforceInvariants.test.js` |
| An active profile with above-bar stored matches never shows a near-empty pipeline (the purge-then-refill gap; G2 anti-zero-result) | `enforcePipelineRefill()` — promotes top `profile_opportunity_matches ≥ AUTO_ADD_SCORE` through the fully-gated `saveToProfilePipeline` (dismissal tombstones, source allowlist, duplicate guard all enforced), RE-SCORED through the canonical engine at promote time so stale stored scores can't inflate; `PIPELINE_REFILL_MIN_ROWS` (default 5); disable via `ENFORCE_PIPELINE_REFILL=0` | `backend/tests/enforceInvariants.test.js` |
| Every 'converted' service application points at a LIVE profile (Convert-to-Profile used to only flip the status flag — the applicant stayed invisible to admin and locked out of login, since prod `/email/start` only admits emails matching an existing profile) | `convertApplicationToProfile()` / `reconcileConvertedApplications()` in `backend/services/serviceApplicationConversion.js` — PATCH route is the per-call gate; boot net `enforceConvertedApplicationsHaveProfiles()` links by email→name or CREATES (intake rows only; 'signup' rows are link-only to avoid duplicating a client); ambiguous matches flagged, never guessed | `backend/tests/serviceApplicationConversion.test.js` |
| Catalog near-duplicate identity (the same real-world program must collapse to ONE `funding_opportunities` row even when re-extracted with paraphrased punctuation/word order — the 7× NAEMT class) | `canonicalOpportunityKey()` in `backend/crawler-os/contract.js` (external_id → token-sorted title+sponsor → URL), consulted by BOTH `crawler-os/storage.upsertOpportunity` and `services/opportunityInserter.upsertFundingOpportunity`. One-time re-key/merge: `backend/scripts/rekey-dedup-catalog.mjs` | `backend/crawler-os/tests/` + `backend/tests/opportunityInserter*.test.js` |
| Pipeline lifecycle statuses tell the truth about who set them (a protected `submitted` means a human/Hamilton actually submitted; bulk imports stamped rows `submitted` from the SOURCE's listing status — grants.gov "(posted)" — with `submitted_date` NULL, permanently shielding never-scored, often-ineligible rows from every purge/re-score net: the HUD Section 4 $42M class) | `enforceImportedStatusHonesty()` — surgical demote to `discovered` ONLY when all three hold: status `submitted` + `submitted_date IS NULL` + import/repair provenance (adapter "(posted)" notes or `admin_schema_repair` explanation); a real submission or human-noted row is never touched; disable via `ENFORCE_STATUS_PROVENANCE=0` | `backend/tests/enforceInvariants.test.js` ("enforceImportedStatusHonesty") |
| A relevant pipeline source's award amount is ACQUIRED when the funder's own page states it (only ~18% of the catalog carried any dollar figure — ingest text is often one aggregator sentence, and nothing ever read the funder's page: the "$0 pipeline full of real sources" class). Companion write-side guards: untrusted-source structured amounts outside the extractor's $100–$10M plausibility window are demoted to TEXT (`resolveOpportunityAmounts` — a $42M program appropriation is not a per-award ceiling; the boot net is `enforceGrantAmountBackfill` step 0, which strips fabricated numerics already persisted AND cleans grant values inherited from them, never touching user-entered asks or awarded money), and wide floor→ceiling ranges (> `WIDE_AWARD_RANGE_RATIO`×) default `amount_requested` from the FLOOR, not the ceiling | `enforceAmountEnrichment()` — bounded per boot (`AMOUNT_ENRICH_BOOT_LIMIT` 10, `AMOUNT_ENRICH_TIME_BUDGET_MS` 20s; the nightly sweep passes a real budget): fetches the source page for active-pipeline catalog rows with no amount via the SSRF-safe crawler-os fetcher, runs the conservative `awardAmountExtractor` (numbers only from explicit per-award phrasings; program totals stay text-only); disable via `ENFORCE_AMOUNT_ENRICHMENT=0`. Page-reader service: `backend/services/amountEnrichment.js`. **Attempt-state is the `funding_opportunities.amount_enrich_attempted_at` COLUMN and the exclusion is a SQL predicate — never a post-LIMIT filter.** The original sweep SELECTed `LIMIT 200` then dropped attempted ids in JS, so once those 200 rows were tried it reported "0 candidates" forever and never reached row 201 (coverage pinned at 12% even after the nightly budget went to 120 — the invariant read green while doing nothing); its `system_kv` ring also capped at 2000 ids. A row is marked attempted only once its page was actually READ, so a fetch that throws is retried (see the URL-rescue rule: a provider outage never burns a candidate's one chance) | `backend/tests/enforceInvariants.test.js` ("enforceAmountEnrichment" — incl. the >200-row regression that fails on the old post-LIMIT filter) + `backend/tests/amountEnrichment.test.js` + `backend/tests/awardAmountExtractor.test.js` |
| Admins are never re-interviewed (an ADMIN/owner account gets Anya's interview at most once; a secondary login must never re-open it — the admin bulk reset stamped `pending_reinterview` onto admin rows too, re-prompting the owner on every login). Non-admins keep the deliberate reset flow | `enforceAdminReinterviewSuppression()` — clears `pending_reinterview` → `completed` on admin rows with any first-run signal (`has_completed_onboarding` / `onboarding_completed_at` / prior `last_login_at`); fresh admins keep their one first-run. Per-call gate: `resolveGuidedCycleTourStatus()` (`backend/services/onboardingGates.js`) at every auth-payload serialization; UI net: global `LoginGapInterviewLauncher` mount never interviews admins | `backend/tests/adminReinterviewGate.test.js` |
| Amy's synthetic training profiles EXPIRE (a `created_by='agent:amy'` synthetic tagged `allow_sam_cleanup` never outlives its `expires_at` past the next boot — Amy's end-of-run cleanup is scoped to the ids crawled in THAT run, so when discovery skips/throws the list is empty, nothing is deleted, and prior runs' leftovers are permanently out of scope: the 13-live/0-reaped prod class) | `enforceAmySyntheticExpiry()` — calls the canonical `cleanupExpiredAmyProfiles()` (`backend/services/amy/amyProfileStore.js`), the SAME guarded sweep the end-of-run second pass in `runAmyTraining` and the nightly sweep use; every guard holds (designated-profile, `allow_sam_cleanup`, `synthetic`, crawled-required with the bounded `AMY_NEVER_CRAWLED_MAX_AGE_HOURS` 96h escape hatch, 6h crawled grace); disable via `ENFORCE_AMY_SYNTHETIC_EXPIRY=0` for count-only. Per-call first line: the unscoped expired-only pass at the end of every `runAmyTraining` (telemetry: `amy.cleanup.expired_sweep`) | `backend/tests/enforceInvariants.test.js` ("enforceAmySyntheticExpiry") + `backend/tests/amyAgent.test.js` |
| A Yana lead's contact email belongs to THAT org (enrichment SORTED candidate homepages by name score then took `candidates[0]` unconditionally — a preference with NO floor, so when nothing matched the org it scraped an unrelated site's address: `helpdesk@franklin.edu` on 10 distinct universities, a newspaper's `admin@conwaydailysun.com` on 14 nonprofits, worldatlas/mathway/roblox addresses on dozens more — 147 of 490 enriched candidates shared an address with a DIFFERENT org, each one making John draft outreach to the wrong organization) | `enforceLeadContactPlausibility()` — strips the address, returns the lead to `needs_enrichment` and RESETS `pushed_to_john`/`enrich_attempts` so the gated enricher can find the right one; never invents a contact, never deletes the lead; bounded (`LEAD_CONTACT_PLAUSIBILITY_LIMIT`, default 500); disable via `ENFORCE_LEAD_CONTACT_PLAUSIBILITY=0` for count-only. Per-call gate: `isPlausibleHomepage()` (`backend/services/yana/prospectExclusions.js`) in `makeContactEnricher` — requires a DISTINCTIVE org token (category words like "university"/"hospital" are never sufficient alone: "Franklin University" ≠ "University of Minnesota") in the hostname or the search-result TITLE (the title is what rescues legitimate abbreviations like upenn.edu) | `backend/tests/yanaEnrichmentPlausibility.test.js` |
| Application-URL rescue (a real candidate rejected ONLY for a missing URL — stage `url` / reason `missing_application_url`, the docs/email/LLM-extract class — gets ONE bounded, budget-paced chance to be rescued with a real, liveness-verified page found by title+sponsor web search; a URL is NEVER invented or guessed, and a search-provider outage never burns a candidate's chance) | `enforceApplicationUrlRescue()` (re-drives the rejection's `raw_meta.candidate` snapshot through the full `upsertFundingOpportunity` gate stack with the found URL; `system_kv` cursor `url_rescue_last_rejection_id` = one attempt each, NOT advanced when every search came back empty/failed; bounds `URL_RESCUE_BOOT_LIMIT` (8) + `URL_RESCUE_TIME_BUDGET_MS` (20s); disable via `ENFORCE_URL_RESCUE=0` for count-only). Finder: `findOfficialUrlForOpportunity()` in `backend/services/urlEnrichment.js` (searchWeb → token-overlap plausibility → `checkUrl` liveness); write-side snapshot: url-gate `logRejection` in `opportunityInserter.js` | `backend/tests/enforceInvariants.test.js` ("enforceApplicationUrlRescue") + `backend/tests/urlEnrichment.test.js` |

### "Recommended" ≠ "strong match" (the locator rule)

A run's recommendation list and the ACCEPT decision are DIFFERENT facts, and
re-coupling them re-creates a two-sided defect. A DIRECTORY locator is a
pointer: it promises a place to look, never an award, and carries no per-award
amount by design. It is admitted to the recommendation list at **REVIEW** by
`isRecommendable()` (`backend/crawler-os/matchEngine.js`) — the single admission
rule both `pipeline.js` and `webLane.js` must consult — while
`computeMatchDecision` never lets it claim ACCEPT.

> Do NOT "fix" a locator visibility problem by letting locators reach ACCEPT,
> and do NOT "fix" a false-positive problem by dropping locators from the list.
> Those are the two ends of one defect: recommendations used to require ACCEPT,
> so #886 made locators ACCEPT to keep the county/211/state-portal/disease
> fleet reachable (hyperlocal_recall_miss ×50/day), which manufactured Amy's
> false_positive ×56. Change the admission rule, not the honesty of the score.

Guard tests: `backend/crawler-os/tests/countyCityAndWishlistLanes.test.mjs`
(a locator stays recommendable AND never claims ACCEPT; a PROGRAM at REVIEW is
NOT recommendable). Amy's `false_positive` detector excludes declared DIRECTORY
locators — they are generically titled by design, so counting them measured the
naming convention, not the matcher; a generic-titled NON-locator clearing
ACCEPT is still a real false positive.

**Never weaken these guardrails:** NULL match_score is not junk; protected
(user-progressed) statuses are never auto-purged; `link_unverified` ≠ dead; all
comparisons are profile-scoped. See the "INVARIANTS" section of
`docs/canonical_rules.md` for the full rationale and the list of invariants that
are documented-but-not-yet-auto-enforced (source denylist, zero-result-but-no-junk,
agent observability).
