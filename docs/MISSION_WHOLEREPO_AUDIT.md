# GrantFlow Whole-Repo Mission Audit

**Branch:** `audit/mission-wholerepo`
**Date:** 2026-06-18
**Method:** Mission invariants decomposed and audited across the whole tracked tree (backend/, src/, shared/, scripts/ — excluding node_modules/dist/coverage and the stale `GrantFlow-public-audit/` copy) via five parallel evidence-gathering passes, each required to cite `file:line`. Highest-confidence root violations fixed at the lowest reusable layer; the remainder documented precisely below. Nothing was claimed "done" without the exact command run.

> Honesty note: this pass fixed the highest-impact, highest-confidence, lowest-regression-risk root causes and **documents** the rest with `file:line` + proposed fix rather than half-implementing large features (e.g. Yana lead discovery) or making broad risky sweeps. The "Documented, not fixed" section is real work remaining, not a claim of completion.

---

## A. Root problems (not symptoms)

1. **Silent loss of real funding opportunities (Goal 1 + "no silent failures").** Robert's `safe()` wrapper swallowed canonical DB-write errors with a bare `catch { return null }`; a verified opportunity that failed to ingest vanished with no log/counter/summary entry while the run still reported success.
2. **Competing match authority (Goals 6 & 7).** `POST /api/ai/match` hand-rolled a keyword scorer (hardcoded `score=50` + ad-hoc bonuses + hardcoded `>=50` threshold) instead of the canonical engine.
3. **Reality verdict gated then discarded (ENFORCE REALITY / RC-8).** The government-import path ran `assessReality` but never persisted `reality_status`, defeating the persisted-verdict fast path.
4. **Dead pipeline-stage filter (Goal 11).** Deadline reminders filtered on `submission_ready`, which is not a canonical stage nor a legacy alias → reminders never fired.
5. **Silent failures presented as real states.** A document-load failure was reported to applicants as "documents missing"; a failed submission-mirror still marked the task "submitted."
6. **Corrupted production string.** Hamilton's e-signature instructions literal was malformed (`' + '` artifacts inside a template literal).

## B. Exact files responsible & C/D. Fixes grouped by system

### Matching authority
- **`backend/routes/ai.js`** (`POST /match`) — replaced the bespoke keyword scorer with the canonical `scoreOpportunity` (already imported in-file as `calculateMatchScore`) and the canonical `DEFAULT_MIN_SCORE` threshold; removed now-dead `keywords`/`focusAreas`/`programAreas`. Now the sole authority computes the score.

### Reality enforcement
- **`backend/services/sources/ingestionService.js`** — the import path now PERSISTS the canonical verdict it already computes: `reality_status` (`allowed`/`downgraded`), `opportunity_kind`, `source_trust_tier`, `reality_reasons` added to INSERT + UPDATE (mirrors `opportunityInserter.js`), so the persisted-verdict fast path works and rows aren't NULL.

### Agents / silent failures
- **`backend/services/robert/robertAgent.js`** — `safe()` now logs every caught error and can record it into the run's `summary.errors`; the critical `ingestOpportunity` call passes that context and a thrown ingest is surfaced as a `rejected` candidate (reason `ingest_error`) so a verified opportunity is never silently dropped. The two bare `catch { return [] }` in `resolveProfileIds`/`fetchOpportunitiesByIds` now log.
- **`backend/vnext/missingnessService.js`** — `listDocumentStructuredForProfile` no longer swallows DB errors silently (logs before returning `[]`), so a load failure isn't mis-reported to applicants as "missing documents."
- **`backend/services/hamiltonApplicationAgent.js`** — a failed submission-mirror (`markSubmitted` throw) is logged and the task is **no longer** marked `submittedAt`; success is only claimed when the mirror actually succeeded.
- **`backend/services/hamilton/hamiltonESignatureService.js`** — fixed the corrupted `instructions` string literal.

### Pipeline
- **`backend/routes/reminders.js`** — deadline filter uses canonical stages (`ready_to_submit`, `gathering_documents`, …) instead of the dead `submission_ready`; reminders now fire.

## E. New / updated tests
- **`tests/unit/robert-agent-silent-failure.test.mjs`** (new) — forces `upsertFundingOpportunity` to throw on a verified opportunity; asserts the failure is recorded in `summary.errors` (`stage: ingest_opportunity`) AND surfaced as a `rejected` candidate (`ingest_error`), the run still completes, and it is NOT counted as ingested. (Was previously a silent drop.)
- **`tests/unit/ingestion-reality-gate.test.mjs`** (+1 test) — asserts an imported clean grant persists `reality_status` (`allowed`/`downgraded`), `opportunity_kind`, `source_trust_tier`, and JSON-valid `reality_reasons`.

## F. Verification commands & results
(All on branch `audit/mission-wholerepo`, Windows, Node 22; baseline before changes was all-green.)

| Command | Result |
|---|---|
| `npm run lint` | **PASS** (zero warnings; includes all changed files) |
| `npm run typecheck` | **PASS** |
| Targeted node:test (robert/ingest/hamilton/reminders/missingness, 124 tests) | **PASS** 124/124 |
| `tests/unit/robert-agent-silent-failure.test.mjs` | **PASS** 1/1 |
| `tests/unit/ingestion-reality-gate.test.mjs` | **PASS** 3/3 |
| `npm run unit` (full) | **PASS** (exit 0) — node:test **2253/2253**, vitest **331 files / 746 tests**. (Also de-flaked one pre-existing timeout: `reverseLookupService.test.js` does ~13s of real DB work and exceeded vitest's 5s default only under full-suite load — passes in isolation, unrelated to these changes; given an explicit 30s timeout.) |
| `npm run build` | **PASS** (exit 0, built in 9.4s) |
| `npm run crawler:doctor` | **PASS** (baseline) |
| `npm run opps:check-national-minimum` | **PASS** (baseline, 35 ≥ 3) |

`npm run smoke:mission` — **SKIPPED, not faked** (needs live creds `GRANTFLOW_BASE_URL` / `GRANTFLOW_TEST_EMAIL` / `GRANTFLOW_TEST_PASSWORD`, all unset).

## Verified CLEAN (audited, no action needed)
- **Loans (Goal 4):** excluded by default at ingest, storage, display, and pipeline layers; no loan→grant relabel; `unknown` funding type stays `unknown`; loan/matching-funds/expired/broken warnings render on the canonical result card.
- **Zero-result ladder (Goals 8-9):** `zeroResultLadder.js` walks 6 diagnostic tiers; `matching.js`/`discovery.js` return `result_tier`/`profile_gaps`/`tier_explanation`/`tier_attempts`; `FundingResults.jsx` and `DiscoverGrants.jsx` render actionable next steps (profile-gap deep links, broaden search, ask Anya).
- **Persistence scoping (Goal 10):** saved grants, dismissals, application tasks, documents, pipeline are DB-backed and scoped by user AND profile; frontend `persist` usage is UI-cache only.
- **Hamilton honesty (Goal 13):** real Playwright automation; returns `blocked` on login/2FA/CAPTCHA/payment/signature; never types federal credentials; only marks `submitted` after a real submit. (The legacy-agent over-claim path is now guarded — see fixes.)
- **Match authority everywhere else:** `robertMatchBridge`, school portal, Anya tools, `resultEnricher`, discovery, and the UI cards all delegate to `computeMatchDecision`/`scoreOpportunity`; UI score→color/label bands are cosmetic.

## Documented — real findings NOT fixed in this pass (with file:line + proposed fix)
> Deferred deliberately (larger scope, or defense-in-depth where the serve boundary already re-derives correctness). Each is a genuine improvement, not a blocker for the fixes above.

1. **Yana "Client Discoverer" is effectively unimplemented (Goal 14).** `backend/services/agentControl/agentAdapters/yanaAgentAdapter.js:126-133` INSERTs into `yana_runs`, but migration `090`/`0086` renamed that table to `hamilton_runs`, so the INSERT throws and is swallowed by `catch {}` while the adapter still returns `completed` — Yana's run is never recorded and `getStatus` is permanently null. `:107-120` reports `leads_pushed_to_john` from a `COUNT(*)` (an action that never happens), and `yana_lead_candidates` is created but **never written** (no producer). _Fix:_ give Yana its own run table (or the shared agent-run store), implement a real qualify-and-push that writes the candidate queue, and stop labeling a COUNT as a completed push. (Structural — a feature, not a one-line fix.)
2. **Reality gate write-side (defense-in-depth; serve path re-derives via `assessOpportunityTrust`).** `backend/routes/crawlers.js:1887` (`seed-local-networks`) and `:2210` (`seed-real-opportunities`) raw-INSERT active rows ungated; `backend/utils/seedBaselineFromRepo.js` auto-runs at startup writing active rows with `reality_status` NULL; `backend/routes/opportunities.js` admin `POST /` (`:1409`) and `POST /bulk` (`:1442`) insert without gating. _Fix:_ route all through `opportunityInserter.upsertFundingOpportunity`/`bulkUpsertFundingOpportunities`.
3. **Pipeline enum drift (display/normalization).** `backend/server.js:2450,2462` invents a `submission_ready` bucket and maps canonical `archived → rejected`; `backend/services/pipelineAutomation.js:6-36` + `backend/prompts/pipelineAutomation.js:1-18` keep a competing `STATUS_ORDER`/`ALLOWED_STATUSES` that normalize toward legacy; `src/components/workflow/ApplicationWorkflowPanel.jsx:28`, `src/components/pipeline/PrintablePipeline.jsx:11`, and filter arrays in `AdvancedAnalytics.jsx`/`Proposals.jsx`/`Outreach.jsx` hardcode stage subsets. _Fix:_ derive all from `shared/pipelineStages.js` (`PIPELINE_STAGES` + `canonicalStage`).
4. **Stripe checkout skips live price verification.** `backend/routes/stripe.js:121` calls `resolveChargeForQuote` without `stripePriceVerification`, so `verifyStripePrice` (wired into Sam/admin only) doesn't run at checkout. Defense-in-depth — Stripe still enforces the canonical amount server-side. _Fix:_ pass `verifyStripePrice(charge.stripe_price_id)`.
5. **Latent dead-end empty state.** `src/components/discovery/SearchResults.jsx:357-369` renders a generic empty panel ignoring ladder diagnostics (currently unreachable on its only page). _Fix:_ consume `diagnostics` or delete the branch.
6. **Borderline match hardening.** `backend/routes/opportunities.js` `GET /geo/scored` (`:1331`) uses the canonical score but skips the decision gate (REJECT rows can show with a score); `backend/routes/grants.js:1043` defaults manual-create `match_decision` to `'review'`. Neither fabricates a competing score.

## G. Caveats
- `smoke:mission` and browser E2E require live credentials / a running deployment; not exercised here (see §F).
- Reality-gate write-side items (Documented #2) are defense-in-depth because every list route re-runs `assessOpportunityTrust`, which re-derives reality live — so even NULL-`reality_status` rows are filtered at serve time today.
