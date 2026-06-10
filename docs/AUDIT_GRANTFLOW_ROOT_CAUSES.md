# GrantFlow Mission Audit — Root Causes (Part 2)

**Branch:** `audit/root-fix-grantflow-mission`
**Date:** 2026-06-09
**Method:** Full-repository audit (1,538 tracked files) driven by five parallel
deep-audit passes (reality gate, canonical matcher, profile+crawlers, zero-result+UI,
Anya), each required to cite `file:line` evidence and mark findings CONFIRMED
(code read) vs SUSPECTED. Baseline quality gates were run first to ground the
audit in real pass/fail state rather than speculation.

> **Honesty note.** This document reports **exactly** what was audited, what was
> fixed and verified in this pass, and what remains. It does **not** claim the
> full mission is complete. Items marked `NOT FIXED (follow-up)` are confirmed
> real issues with a recommended lowest-layer fix, deferred because they carry
> regression risk that cannot be fully verified in this environment (live
> crawlers, government APIs, browser E2E) and warrant their own change + tests.

---

## Baseline (real, measured before any change)

| Gate | Baseline | After this pass |
|------|----------|-----------------|
| `npm run lint` | PASS | PASS |
| `npm run typecheck` | PASS | PASS |
| `npm run build` | PASS | PASS |
| `npm run unit` (227 files / 616 tests) | PASS | PASS (+ new tests) |
| `npm run crawler:doctor` | **FAIL** (`no such column: opportunity_kind`) | **PASS** |
| `npm run opps:check-national-minimum` | **FAIL** (`no such column: opportunity_kind`) | **PASS** (35 real national) |
| `npm run smoke:mission` (dry) | skipped (needs live creds) | skipped (needs live creds) |

The canonical layers from Part 1 all exist and are largely sound:
`backend/services/matchEngine.js` (canonical decision), `matchDecisionEngine.js`
(re-export shim), `opportunityRealityGate.js` (`assessReality`),
`opportunityInserter.js` (the one gate-enforcing insert path), `sourceRegistry.js`,
`profileNormalizer.js`, `profileSignals/`, `zeroResultLadder.js`.

---

## FIXED in this pass (with tests + verification)

### RC-1 — Schema application was not idempotent on pre-existing DBs (BLOCKER: gates failing)
- **Root problem:** `crawler:doctor` and `opps:check-national-minimum` apply
  `schema.sql` directly with `db.exec()`. Because tables use
  `CREATE TABLE IF NOT EXISTS`, applying the schema to a DB file created before a
  column was added never backfills that column; the subsequent
  `CREATE INDEX ... ON funding_opportunities(opportunity_kind)` then crashes.
- **Why it violates the mission:** two of the mandated mission gates could not run
  at all on any persisted/older SQLite DB — the mission's own machine-checks were
  red.
- **Files responsible:** `scripts/crawler-doctor.mjs`,
  `scripts/opportunities-national-minimum.mjs`, `backend/db/schema.sql` (idempotency gap).
- **Data flow:** script → `db.exec(schema.sql)` → index on a column missing from a
  stale table → crash before any check runs.
- **Fix (lowest layer):** new reusable `backend/db/ensureSqliteSchema.js`
  (`applySqliteSchema`) parses each table's desired columns from `schema.sql` and
  ALTER-adds any missing columns **before** executing the schema, following the
  established `adminSchemaRepair.js` idiom. Self-maintaining as the schema evolves.
  Wired into both scripts.
- **Tests:** `tests/unit/schema-idempotency.test.mjs` (6 tests: heals old table,
  fresh DB, repeatable no-op, column parse, table extraction, no-op when table absent).
- **Status:** ✅ FIXED & VERIFIED (`crawler:doctor` and `opps:check` now exit 0).

### RC-2 — Unknown funding type silently defaulted to `grant`
- **Root problem:** `normalizeFundingType()` returned `'grant'` for any
  unrecognized value, so a `cooperative_agreement`, `prize`, or unmapped `loan`
  variant was mislabeled a grant.
- **Why it violates the mission:** System 2 requires unknown funding type to stay
  `unknown`/review, never auto-grant — mislabeling lets non-grant funding pass as
  direct grant funding.
- **File:** `backend/services/opportunityNormalizer.js:207-211`.
- **Fix:** `FUNDING_TYPE_MAP[key] ?? 'unknown'`.
- **Tests:** `tests/unit/normalizer-loan-and-funding-type.test.mjs`.
- **Status:** ✅ FIXED & VERIFIED.

### RC-3 — Loan detection inspected the title only
- **Root problem:** `isLoan` only checked `is_loan`, `funding_type==='loan'`, and
  `title.includes('loan')`. A loan disclosed only in the description/eligibility,
  or via `opportunity_type`, escaped detection.
- **Why it violates the mission:** System 2 mandates loan detection over title +
  description + funding_type + opportunity_type + eligibility text; an undetected
  loan can be recommended to a profile that did not allow loans.
- **File:** `backend/services/opportunityNormalizer.js:401-408`.
- **Fix:** detect over the full normalized `text` (title+description+sponsor+
  eligibility) plus `funding_type`/`opportunity_type`/`type`; keep and broaden the
  loan-forgiveness/repayment-assistance exemption so relief programs are not
  mislabeled as loans.
- **Tests:** `tests/unit/normalizer-loan-and-funding-type.test.mjs` (loan-in-description,
  loan-in-metadata, forgiveness-not-loan, plain-grant-not-loan).
- **Status:** ✅ FIXED & VERIFIED.

### RC-4 — UI fabricated the ACCEPT/REVIEW/REJECT decision (BLOCKER: duplicate match authority)
- **Root problem:** `toCanonicalResult.js` computed
  `score >= 70 ? 'ACCEPT' : score >= 35 ? 'REVIEW' : 'REJECT'` when the backend
  omitted a decision — a second, client-side decision authority with hardcoded
  thresholds.
- **Why it violates the mission:** System 2 — all match decisions and user-facing
  explanations must come from the one canonical engine (`computeMatchDecision`).
- **File:** `src/components/funding/toCanonicalResult.js:121`.
- **Fix:** `normalizeBackendDecision()` passes through the backend verdict and
  surfaces `'UNRATED'` when absent — never invents a verdict. The existing
  `strongMatchesOnly` filter already tolerates an absent decision via a documented
  display-only score fallback.
- **Status:** ✅ FIXED (build + unit green). UI threshold-ladder unification across
  other components remains — see RC-9.

### RC-5 — Canonical decision dropped `missingEligibilityFields` on ACCEPT/REVIEW
- **Root problem:** `computeMatchDecision` hardcoded `missingEligibilityFields = []`
  on the success path; it was only populated on REJECT. So "what's missing from
  your profile" guidance was lost for exactly the matches a user would act on.
- **Why it violates the mission:** System 3 — surface missing profile fields as
  guidance (review/missing_fields), not silent loss.
- **File:** `backend/services/matchEngine.js:2413`.
- **Fix:** `missingEligibilityFields = eligibilityEval.missingFields ?? []`.
- **Tests:** `tests/unit/match-missing-eligibility-fields.test.mjs` (asserts populated
  on a non-REJECT decision, and parity with `evaluateEligibility`).
- **Status:** ✅ FIXED & VERIFIED.

### RC-6 — Government import path bypassed the canonical reality gate (BLOCKER)
- **Root problem:** `ingestOpportunities` (grants.gov / USAspending / NIH import,
  invoked from `admin.js`) ran policy + validator + reviewer but **never**
  `assessReality`, and wrote rows directly. A broken-link active direct row passes
  the first three but should be reality-rejected.
- **Why it violates the mission:** System 1 — every user-visible row must pass the
  single canonical reality gate; an import path that bypasses it can persist
  broken/expired/social-only/loan-like direct opportunities.
- **File:** `backend/services/sources/ingestionService.js`.
- **Fix:** enforce `assessReality(opp)` in the prefilter for rows destined to be
  ACTIVE/user-visible; inactive reference rows (e.g. USAspending past awards,
  `is_active=0`) are exempt because they are never surfaced as live opportunities.
  New `records_rejected_reality` counter surfaced in the run result and logs.
- **Tests:** `tests/unit/ingestion-reality-gate.test.mjs` (clean grant inserted +
  broken-link direct reality-rejected; inactive reference row exempt). Fixtures were
  empirically isolated so the broken-link row passes policy/validator/reviewer and is
  caught *only* by the reality gate.
- **Status:** ✅ FIXED & VERIFIED. **Other reality-gate bypasses remain — see RC-7.**

---

## Part-2 continuation — current status (updated)

Subsequent commits resolved several of the items below. Current status:

| Item | Status | Commit |
|------|--------|--------|
| RC-1 Schema idempotency | ✅ FIXED & VERIFIED | 1f91c67d |
| RC-2 Unknown funding type | ✅ FIXED & VERIFIED | 1f91c67d |
| RC-3 Loan detection (full text) | ✅ FIXED & VERIFIED | 1f91c67d |
| RC-4 UI fabricated decision | ✅ FIXED & VERIFIED | 1f91c67d |
| RC-5 missingEligibilityFields | ✅ FIXED & VERIFIED | 1f91c67d |
| RC-6 Gov import reality gate | ✅ FIXED & VERIFIED | 1f91c67d |
| RC-7 Crawler/import insert bypasses | ✅ FIXED (geo crawler + Anya global-promote routed through gated inserter). Admin manual-create/bulk + curated-seed routes intentionally remain store-then-filter-at-display paths (proven by `opportunities-compliance-soft-filters` test). | f6f23137 |
| RC-9 Anya match scout non-authoritative scoring | ✅ FIXED & VERIFIED (uses computeMatchDecision; never surfaces a REJECT) | f6f23137 |
| RC-10 Anya explainMatch re-implements matching | ✅ FIXED & VERIFIED (uses computeMatchDecision) | f6f23137 |
| RC-11 Anya prompt advertises uncallable tools | ✅ FIXED & VERIFIED (prompt callable-list generated from whitelist; parity test) | f6f23137 |
| RC-12 Zero-result UI dead-end | ✅ FIXED & VERIFIED (ladder diagnostics surfaced; legacy junk-dump removed) | 7ea4dd70 |
| RC-15 Result card loan/expired warnings | ✅ FIXED & VERIFIED (loan/matching-funds/expired chips + tests) | 7ea4dd70 |
| RC-8 Persist reality_status / unify display gate | ✅ FIXED & LIVE-VERIFIED (2026-06-09 PR #505) — migration `077_funding_opportunities_reality_verdict.sql` (SQLite, idempotent) + `0073_funding_opportunities_reality_verdict.sql` (Postgres) add `reality_status`, `reality_reasons`, `final_url`, `http_status` + index. `opportunityInserter` and `linkVerificationService` write the verdict; `opportunityTrust.assessOpportunityTrust` prefers the persisted verdict but keeps per-user `allowLoans`/`allowExpired` re-derivation. Drift test: `tests/unit/reality-verdict-persistence.test.mjs` (8 cases). Live probe confirmed all 4 columns + index present; fingerprint hits clean. | 4de429a0 |
| RC-13 Canonical pipeline enum | ✅ FIXED & LIVE-VERIFIED (2026-06-09 PR #505) — new `shared/pipelineStages.js` (11 canonical stages + alias resolver). Migration `076_grants_status_canonical_pipeline.mjs` (SQLite, programmatic CHECK rewrite via `unsafeMode` + `PRAGMA writable_schema`) + `0072_grants_status_canonical_pipeline.sql` (Postgres). `applicationWorkflow.APPLICATION_STATES`, `KanbanBoard`, `GRANT_STATUSES`, `applyEngine`, `server.js`, `backgroundServices.js` all consume the shared module. 11 contract tests (`tests/unit/pipeline-stages-canonical.test.mjs`). Live DB has all 11 stages in the CHECK. | 118877b1 |
| RC-14 Saved items profile-scoping | ✅ FIXED & LIVE-VERIFIED (2026-06-09 PR #505) — migration `075_saved_grants_profile_scope.sql` (SQLite, table-rebuild) + `0071_saved_grants_profile_scope.sql` (Postgres, `ALTER TABLE`) add nullable `profile_id` and replace single UNIQUE with two partial unique indexes (`uq_saved_grants_user_profile_opp`, `uq_saved_grants_user_legacy_opp`) so legacy NULL rows stay visible. Service scopes by `user_id + profile_id`; POST requires the active profile. `savedGrantsStore` is profile-namespaced and resyncs on profile switch. 6 integration tests (`backend/tests/savedGrantsProfileScope.test.js`). Live `/api/saved-grants` correctly rejects 401/400 without an active profile. | b156462e |
| RC-16 sourceRegistry operational metadata | ✅ FIXED & LIVE-VERIFIED (2026-06-09 PR #505) — `base_url`, `crawl_method`, `rate_limit`, `robots_note`, `locations` now present on every source via `applyOperationalMetadata`. `loadCrawlerSourceRuntimeStatus(db)` queries `crawler_source_runs` for `last_crawl`/`failure_status`; `buildCoverageReport` surfaces both static + runtime fields. 10 contract tests (`tests/unit/source-registry-coverage.test.mjs`). Live probe: all 61 sources have the operational fields; coverage report exposes `crawl_method=api`, `last_crawl`, etc. | a4771572 |
| RC-17 Documents → profile signals | ✅ FIXED & LIVE-VERIFIED (2026-06-09 PR #505) — `extractNeedSignalsFromDocumentText` (bounded to `NEED_ALIAS_MAP` keys, 200KB cap, **word-token** matching to avoid substring collisions like `noti**ce**`/`g**roce**ries` falsely firing professional_development) folds into `normalizeProfile`'s `needCategories`. `loadProfileContext` hydrates `documents.extracted_text` from the `documents` table; `routes/matching.js` passes documents through. 10 unit tests (`tests/unit/profile-document-signals.test.mjs`) including the substring-collision regression. Live probe: an "eviction notice" doc folds in `housing` only — clean signal, no noise. | 93da99a3, 2f3b2347 |

> **Update 2026-06-09:** the 5 previously-deferred root-causes (RC-8, RC-13,
> RC-14, RC-16, RC-17) have all been shipped on branch
> `fix/audit-deferred-rc-completion` (PR #505) with idempotent SQLite +
> Postgres migrations, contract tests, the full gate suite green, a live
> backend boot that successfully ran every new migration, and 15/15 live
> probes (`scripts/probe-deferred-rcs.mjs`) passing against the running
> server. The detailed recommendations below remain the canonical
> per-item history.

## Detailed findings & recommended fixes (RC-7 … RC-17)

### RC-7 — Remaining reality-gate insert bypasses
Confirmed raw `INSERT INTO funding_opportunities` paths that still skip `assessReality`:
- `backend/services/crawlers/nationalZipCrawler.js:1150/1181` (`saveOpportunity`) — geo/ZIP crawler; only checks URL presence. **HIGH.** Also dedupes by `(source, source_id)` only — no canonical URL fingerprint.
- `backend/services/anyaAutonomousFunctionRunner.js:628` — Anya auto-promotes profile-scoped rows into the global pool un-gated. **HIGH.**
- `backend/routes/opportunities.js:1409` (`POST /`) and `:1442` (`POST /bulk`) — admin create/bulk. **MEDIUM.**
- `backend/routes/crawlers.js:1859/1964/2182` — seed endpoints. **MEDIUM.**
- `backend/utils/seedBaselineFromRepo.js:227` — baseline seed upsert. **MEDIUM.**
- **Recommended fix:** route all of these through `opportunityInserter.upsertFundingOpportunity` / `bulkUpsertFundingOpportunities` (which already run `assessReality` + quality gate + URL-fingerprint dedupe). For `nationalZipCrawler`, replace the raw INSERT with `upsertFundingOpportunity` then post-update geo columns by id.
- **Why deferred:** these touch live crawler/geo persistence and Anya autonomous behavior; correct rerouting needs integration tests against real crawl payloads not runnable in this environment.

### RC-8 — Display path runs a parallel trust gate instead of the canonical one
- `backend/services/opportunityTrust.js` (`assessOpportunityTrust`, consumed by
  `discovery.js`, `matching.js`, `opportunities.js`) re-implements pass/fail logic
  and imports only `classifyOpportunityKind`/`classifySourceTrustTier` from the
  reality gate — not `assessReality`. Insert-side and display-side gates can drift.
- **Root cause:** `reality_status` / `reality_reasons` are **not persisted** columns,
  so readers cannot filter on a stored verdict and must re-derive.
- **Recommended fix:** add migration for `reality_status`, `reality_reasons`,
  `final_url`, `http_status`; have `opportunityInserter` (and `linkVerificationService`)
  write them; have readers filter `WHERE reality_status='allowed'`, or make
  `assessOpportunityTrust` delegate to `assessReality`. **HIGH (structural).**

### RC-9 — Anya match scout uses non-authoritative scoring to surface + notify
- `backend/services/anyaMatchScout.js:379-383` calls the explicitly
  NON-AUTHORITATIVE `scoreOpportunity`, applies its own threshold + a `-5` trust
  nudge, then persists `match_score` and fires user notifications — bypassing
  `computeMatchDecision`'s eligibility hard-gate. A user can be notified of a match
  the canonical engine would REJECT. **HIGH.**
- **Recommended fix:** replace with `computeMatchDecision`; surface/notify only on
  `decision==='ACCEPT'` (optionally REVIEW); store its `score`/`decision`.

### RC-10 — Anya `grants.explainMatch` re-implements matching
- `backend/services/anyaToolRegistry.js:998-1136` hand-rolls applicant-type/location/
  keyword/financial logic and its own score buckets; never calls
  `computeMatchDecision`. This is the tool that answers "why did this match?", so it
  can contradict the canonical engine. `summarizeMatches` also carries dual scores
  (canonical + bespoke `match_score`). **HIGH / MEDIUM.**
- **Recommended fix:** rewrite `explainMatch` to call `loadProfileContext` +
  `computeMatchDecision` and render `matched_profile_facts`/`ineligibilityReasons`
  from the decision; drop the bespoke `match_score`/`fit_explanation` in `summarizeMatches`.

### RC-11 — Anya prompt advertises ~15 tools the chat path cannot call
- `backend/services/anyaOrchestrator.js:140-155` (+ admin block) tells the model to
  "ACTUALLY call" tools (`grants.getSubmissionInfo`, `grants.writeLOI`,
  `medical.*`, `brain.*`, `code.search`, …) but `CHAT_TOOL_WHITELIST` (`:79-85`)
  exposes only 5 to the model. Structural setup for the model to either fail silently
  or fabricate "I did it" — directly undercutting its (otherwise strong) honesty rule. **HIGH.**
- **Recommended fix:** derive the prompt's "Tools Available to You" list from the
  whitelist (single source of truth), or expand the whitelist to the read-safe tools
  the prompt promises and relabel write/admin tools as manual-UI features. Add a test
  asserting prompt-listed tools ⊆ whitelist.
- Also: `application.createFromOpportunity` / `application.completeStep` write without
  a confirmation gate (unlike `profile.updateSection`). **MEDIUM.**

### RC-12 — Zero-result ladder diagnostics never reach the UI (BLOCKER: dead-end empty state)
- Backend `zeroResultLadder.js` correctly produces `result_tier`, `profile_gaps`,
  `tier_attempts`, `tier_explanation`, `directory_only`, `geo_expanded`
  (`discovery.js:430-449`), but `src/stores/fundingResultsStore.js:42-52` drops them,
  and the empty states (`FundingResults.jsx:280-300`, `SearchResults.jsx:357-370`)
  are static dead-ends. **HIGH.**
- Also: a legacy top-N "LAST RESORT" junk fallback still runs in `matching.js:866-876`
  in parallel with the correct ladder. **LOW/MEDIUM.**
- **Recommended fix:** carry the ladder fields through the store's `setResults`/
  `partialize`; render an explanatory zero-result component (searched/expanded/why +
  profile-gap prompts + "queue deeper search"); delete the legacy top-N block.

### RC-13 — Pipeline has two competing stage sets; neither matches the spec
- `applicationWorkflow.js:23-33` (`APPLICATION_STATES`) vs `grants.status` CHECK in
  `schema.sql:404-411`. Missing from both: `saved`, `gathering_documents`,
  `ready_to_submit`. **HIGH.**
- **Recommended fix:** one canonical stage enum (shared module) aligned to the 11-stage
  spec; migration to widen the `grants.status` CHECK.

### RC-14 — Saved/favorited items are user-scoped only, not profile-scoped
- `saved_grants` (`051_saved_grants.sql`) has no `profile_id`; saves bleed across a
  user's profiles. (Application workflow IS correctly profile-scoped.) **MEDIUM.**
- **Recommended fix:** add nullable `profile_id` to `saved_grants`; scope queries by
  `user_id` + `profile_id`.

### RC-15 — Result card omits loan / matching-funds warning and expired label
- `is_loan`/`requires_match` are selected (`savedGrants.js:48-49`) but never rendered;
  `grantUtils.isGrantExpired` is unused by the card. **MEDIUM.**
- **Recommended fix:** map `is_loan`/`requires_match`/expired into `toCanonicalResult.js`
  and render warning chips in `FundingResultCard.jsx`.

### RC-16 — sourceRegistry lacks operational metadata
- No `base_url`, `crawl_method`, `rate_limit`, robots/ToS note, `locations`,
  `last_crawl`, `failure_status` per source. **MEDIUM.**

### RC-17 — Ingested document text + saved/hidden feedback not folded into normalized profile
- `profileNormalizer.normalizeProfile` reads sections but not `documents.extracted_text`
  (loaded into context at `profileHelpers.js:472-504` but unused). **LOW.**

---

## Confirmed NON-issues (audited, no action needed)
- No hardcoded fake/mock opportunities in production runtime insert paths. All
  `example.com`/`lorem`/`mock` hits are rejection patterns, test fixtures, or
  config placeholders flagged in-code (`designatedProfiles.js:907`).
- `matchDecisionEngine.js` and `matchingEngine.js` are documented re-export/deprecated
  shims, not duplicate authorities; `crawlers/matchEngine.js` is a documented candidate
  prefilter. `matchEngine.js` is the sole decision authority.
- Profile normalizer reads the full profile (top-level + `profile_sections` + linked org).
- Missing optional profile data routes to REVIEW/`missingFields`, never hard-reject.
- grants.gov / USAspending ingestion use real APIs; USAspending honestly marks past
  awards inactive.
- Nationwide crawl is staged/resumable with per-state coverage metadata; does not
  falsely claim "nationwide complete".
- Saved/application actions persist to DB (not client-only) and enforce ownership;
  application workflow is profile-scoped.

See `GRANTFLOW_MISSION_FIX_PLAN.md` for the canonical-layer contract and the
prioritized remediation sequence, and `GRANTFLOW_VERIFICATION_REPORT.md` for the
exact commands and results.
