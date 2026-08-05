# FAILURE REGISTER — GrantFlow recovery

Audit anchor: `9dfbfaff7189746ed354ea06181799cda4e88db4` (2026-08-03).
Every entry cites code evidence at the anchor. Status vocabulary: CONFIRMED (traced in
code this audit) / MEASURED (prod numbers, source cited) / OPEN / IN-PR / FIXED (only
with session-local proof).

## F-01 — Source tree was self-modifying via the materialization patch stack — FIXED (live-verified 2026-08-03)
Merged as #1149 (`f07b3ffe`); prod image at `fc30ee3f` was built by the
materializer-free Dockerfile and passes /readyz + mission gate (PRODUCTION_TRUTH.md).
Stays-removed guard: `tests/unit/deployment-entry-points.test.mjs`.
- Symptom: 8 npm lifecycle hooks + the Docker build run `scripts/materialize-production-source.mjs`,
  which can rewrite **45 tracked files** (28 product runtime, 11 tests, 3 env examples,
  2 of its own patch modules) via 27 patch modules (~5,100 lines), gated by bare
  substring signatures.
- CONFIRMED facts: all 45 targets tracked, none git-ignored; `prepare.mjs` rewrites
  `apply-code.mjs` (patcher-patches-the-patcher); the full regeneration path would
  CRASH if entered (pre-transform anchors no longer exist — the system cannot rebuild
  the tree it claims to build); byte-identical rewrites churn mtimes on every
  test/build/start.
- **F-01a (live bug): the verification gate never runs.** `apply-amy-organization-identity-dedupe.mjs`
  calls `process.exit(0)` at module top level on the already-applied path; because
  modules are dynamically imported into the driver's process, the driver dies before
  the `missingIncremental` check and final verification line. Empirically confirmed
  2026-08-03: driver run in a clean worktree exits 0 with the final
  "verified product source already present" line never printed.
- Root cause: permanent repairs were shipped as install-time patches instead of commits.
- Correction: equivalence proven (materializer run in clean worktree at anchor →
  `git diff --quiet` exit 0), then full removal — branch `recovery/remove-source-materialization`
  (deletes the stack, strips 8 hooks + Docker steps, rewrites the 4 dependent
  tests/checks, adds a stays-removed guard test). Verification pending: full local
  test chain + CI.

## F-02 — Display/read-path second authorities can overturn the canonical engine — OPEN (top slice of the #1140/#1142 class)
Census of 17 hazards (full detail: audit census, 2026-08-03). Highest severity:
- **HZ-1**: `relevanceFilter.js:170` — `mode === 'strict'` collapses EVERY soft rule
  into a hard drop; `profileSpecificGate.js:471` calls display filtering with
  `mode:'strict'`. ~27 non-hard rules (age/demographic/disability/profession/entity/
  enrolled-benefit/content classes) still hard-drop engine-ACCEPTed rows. Same class
  as #1140/#1142, one module deeper.
- **HZ-2/HZ-3**: `needFirstMatchPolicy` is a parallel decision engine applied twice per
  read; `needFirstReconciler.js:116-134` UPDATEs `match_score`/`match_decision` from
  inside a GET (`routes/fundingSources.js:147`) — a user opening the tab can
  permanently lower engine-endorsed scores.
- **HZ-5**: the reconciliation sentinel (`resultEnricher.js:286-296`) counts only
  `SUPPRESSIBLE_NO_FIT_RULE_IDS` drops — blind to HZ-1/trust/junk-bucket/needFirst
  drops, so the class it exists to catch reads 0.
- **HZ-8**: the zero-result recovery ladder (`routes/matching.js:602-607`) omits
  `useStoredDecision`, so the RECOVERY path applies the full strict net the normal
  path suppresses — the relaxation ladder is stricter than the ordinary read.
- **HZ-11**: `matchDecisionIntegrity.js:107-112` deletes on stale embedded
  `canonical_decision === 'reject'` even when the stored decision is ACCEPT.
- **HZ-13**: `DiscoverGrants.jsx:610-618` client floor lacks the ACCEPT bypass that
  `qualifiesForDisplay` has.
- Retired-scale thresholds in live consumers: `FundingResults.jsx:156` (`>= 70`),
  `anyaContextBuilder.js:295-296` (`>= 50`/`>= 30` — permanently reports 0),
  `enforceInvariants.js:1641` (`|| 75` latent fallback).

## F-03 — Rolling-snapshot match store never re-adjudicates the catalog — OPEN, MEASURED
507 curated_verified sources → 6-7 ever matched (1.2%); web_search 2.2%; engine
replays ACCEPT on the dropped pairs. Named "STILL OPEN WORK" by canonical rules.
Fix shape: general re-adjudication sweep (ACCEPT-only, SQL-predicate candidates,
bounded, own matcher_version) — the five shipped recall nets are the precedent.
BLOCKED-BY-ORDER: land after F-02's top hazards so re-linked rows aren't re-dropped
at display.

## F-04 — Platform health gates on liveness only — CONFIRMED, OPEN
Railway + Docker probe `/healthz` (railway.json:9, Dockerfile:89-90), which reads
only boot-time `app.locals` flags and NEVER queries the live DB (routes/health.js:221-247).
A container whose DB dies post-boot serves 200 forever; `/readyz` (full checks +
mission gate) gates nothing platform-side. Note: pointing Railway at /readyz creates
a deploy deadlock by design (documented in check-deployment-config) — the fix is a
DB-liveness probe inside /healthz or a Sam-driven alarm, not a blind swap.

## F-05 — Boot migration failures are swallowed — CONFIRMED, OPEN
`runPendingMigrationsOnBoot` outer catch logs only (server.js:943-945); per-file
failures leave files unstamped with only "schema check: DRIFT" recorded; nothing
gates on the enforceInvariants per-step `ok:false` counts (a step can fail every
boot forever). `system_kv.enforce_invariants_last_run` write is itself in bare catch.

## F-06 — Dead code carrying live risk — CONFIRMED, OPEN (deletion candidates)
- Dead schedulers with zero runtime importers: `startup/backgroundServices.js` (749 L;
  its absence means `emailGrantScheduler` NEVER runs — decide: wire or delete),
  `startup/queueRecovery.js`, `crawler-os/scheduler.js`, `services/anyaBootstrap.js`,
  `startup/bootstrap.js` (594 L).
- Dormant rival engines: `profileIntelligence/relevanceScorer.js` (own 0-100 scale,
  `>= 75` STRONG) + `eligibilityFilter.js` (`>= 70`) — one import re-arms a full
  second authority.
- Unreachable item crawlers: `itemFundingCrawler.js` (1,148 L), `itemCrawler.js`,
  `itemGiftCrawler.js` (superseded by itemNeedSearch).
- Name collision: two different `isFundableOpportunity` exports
  (`config/fundingResultFilters.js:257` vs `services/matching/qualityGate.js:110`).

## F-07 — packetPdf browser launch drops container args — FIXED, DEPLOYED (behavior exercised on next prod PDF render)
Merged as #1151 (`fc30ee3f`, the live prod SHA). Totality tripwire:
`backend/tests/browserLaunchArgs.test.js` (failing-first verified).
`services/packetPdf.js:26,:50` — bare `chromium.launch({headless:true})` with no
`CHROMIUM_CONTAINER_ARGS` (`--disable-dev-shm-usage` omission previously OOM-killed
the container). `hamiltonApplicationPacketGenerator.js:477-480` keeps args but not
the full-chromium channel (intentional per browserLaunch.js:31-32). One-line fix +
grep-guard test.

## F-08 — Mission failures measured at anchor (context, tracked elsewhere)
Google-parity 47.1/100 falling; zero autopilot submissions since 2026-07-04;
70 authorized tasks stalled (dominant: no clear application URL — runtime URL rescue
shipped in #1128, deploy state to confirm); 43 `submitted` tasks / 0 durable external
proof at last prod audit (re-labeling shipped #1114-class).
