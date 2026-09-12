# 2026-09-12 — production-readiness chain: discovery → confirmation

Basis: owner's production-readiness assignment (eight failure areas), worked on
branch `fix/prodready-discovery-chain` from `origin/main 68bf357f`. Every
number below was measured this session against production (read-only) unless
marked UNKNOWN. Machine-readable baseline + system_kv dumps + subsystem maps:
`C:/Users/firer/AppData/Local/Temp/gf-prodready-837e6deb/` (baseline.mjs
recomputes it; deploy-verify.mjs proves API/web commits).

## Baseline (16:39Z, main 68bf357f on Railway and Vercel dpl_A9weE1Vq…)

| Surface | Measured |
|---|---|
| `/readyz` | 503 `mission_gate_failed` — `release_catalog_verified_pct` 84.9% (<95), `visible_direct` 18,263/18,344 |
| 7-day live-crawl window (09-06..09-12, `crawler_gap_learning.days`) | 1,722 / 1,774 calls with a gap; `result_floor_shortfall` 1,696 and `low_results` 1,696 are the SAME events double-counted; `hyperlocal_gap` 429; `surfacing_regression` 50 |
| Last 30 live web-lane runs | ok:true, 786 queries planned, 1,448 pages, 1,242 fetched, **0 extracted, 0 stored**, reason null |
| Amy cohort (run amy-2026-09-12T11-31-58) | 50 planned, 50 evaluated, 0 clean, `hyperlocal_recall_miss` ×50, `qualification_proven` false |
| Google-bar parity (08:31Z) | fleet 0/100; McCosh overlap 0 / web_only 14 / stored 32; Botts 0 / 14 / 23; all 6 queries served from cache, age unknown |
| Sam preflight (30d) | 59 completed / 45 blocked; all 45 = critical `/readyz returned 503`; step result carried counts only |
| Durable confirmed submissions (predicate-mirroring SQL) | **0** (44 tasks `submitted` are internal records; the only confirmation_reference in the table is the DOM id `children-notification-children-notification`) |
| LLM providers | OpenAI 429 `credit_balance_exhausted`; Anthropic 400 credit exhausted until the owner topped up (~16:50Z); both Groq free routes failing; 48 provider-failure log lines in one 25-min window |

## Root causes established

1. **Extraction outage mis-attributed as recall gaps.** Every LLM route was
   dead 09-03..09-12; `webLane.js` swallowed the extractor error and
   `web_lane_health` recorded `ok:true extracted:0 reason:null`, so the coverage
   audit classified the zero-extraction crawls as `result_floor_shortfall` /
   `low_results`, and Amy classified the same profiles as
   `hyperlocal_recall_miss` code-change items. Provider recovered 17:15Z after
   the owner's Anthropic top-up (verified through the app's own
   `invokeJsonWithFallback` ladder: anthropic 4.4s, free:groq 1.7s).
2. **`/readyz` 503 for ten days = link-verifier starvation.** The recurring
   verifier ordered its 300-row batch by `last_verified_at ASC` over ALL active
   rows including hidden ones; the release gate counts only the visible
   catalog. Measured: next selection 282 hidden / 18 visible; last 4h 298
   hidden / 4 visible refreshed; 3,934 visible pointers past 30 days.
3. **All 45 Sam preflight blocks** were that one critical finding; the block is
   intentional policy but named no prerequisite or operator action.
4. Query plan: 28 planned, ~6 executed under the 44-page cap; rotation inert
   for non-shortfall profiles; no tier provenance; AK/LA "County" suffix;
   `community_development` / `environment` / `utilities` dropped in need
   derivation; org profiles receive individual safety-net phrasing.
5. Parity: `normalizeUrlKey` kept query strings; stored side had no pointer
   filter; no per-web-only disposition; gap queue marked extraction failures
   as `gated_out`.
6. Hamilton: verifier spread stale `result_json` over a promoted submission;
   `declared_receipt_url` accepted by the orchestrator but rejected by the
   artifact registrar; failed-click park was a zero-row UPDATE; proof documents
   deduped across tasks.

## Shipped in this branch

- `backend/services/linkVerificationService.js` — visible catalog takes the
  bounded slot first (visible → hidden-restorable → hidden, oldest within
  tier). Test `linkVerificationVisibleFirst.test.js`.
- `backend/services/observability/metricEnvelope.js` — one envelope
  (window, population, evaluated/unevaluated, sample size, code version,
  provider health, freshness) + `canCloseRegression()`.
- Sam preflight (`samAgentAdapter.evaluateSamPreflight`) names every critical
  finding, readyz reason, release-blocker code and a concrete operator action;
  HTTP findings carry `check_id`; missing loopback probe is visible (blocks in
  production); terminal run status `blocked`. Tests `samPreflightGate.test.js`
  (28), orchestrator unit (real adapter + injected probe), full-cycle with the
  gate ON.
- `backend/crawler-os/webQueries.js` — `buildWebQueryPlan()` returns tiered
  entries (anchor/core/breadth, family, gap_class, need) plus dropped-by-budget
  and dropped-duplicate ledgers; HEAD GUARANTEE (first min(max,6) positions
  carry every anchor, the strongest core and one rotated breadth slot); real
  rotation for every profile; `normalizeQueryKey`; state-aware
  `countyPhrase` (AK borough / LA parish / PR municipio); canonical declared
  needs survive derivation (`community_development`, `environment`,
  `utilities`); hyperlocal families keyed to applicant identity (org grant
  intent, need-keyed school-district, higher-ed on `is_higher_ed`, student
  crisis safety-net in the rotated pool, nearbyCities filters non-place ZIPs).
  Tests: `webQueryPlan.test.mjs`, `hyperlocalFamilies.test.mjs`,
  `declaredNeedSurvival.test.mjs`, `hyperlocalIntersectionsFaithfulPath.test.js`.
- Amy (`backend/services/amy/discoveryGate.js` + report/flywheel/catalog/
  ledgers) — one discovery gate decides evaluable vs
  `discovery_blocked:<no_crawl|provider_unavailable|extraction_failed|…>`; a
  blocked member is unevaluable (never clean, never an issue, never
  omitted); recall-miss findings fire only on a healthy executed lane; per-
  member baseline persisted (generated queries with tiers, executed queries,
  provider health, extracted/canonical candidates, qualification/admission
  decisions, final class); catalog floor rotates by run day; probe approval
  items keyed per finding type; contended locks name their holder.
  `backend/scripts/amy-cohort-baseline.mjs` reconstructs the exact 50 planned
  members offline (50/50 exact against the 09-12 report).
- Web parity (`backend/services/webParityBenchmark.js`) — one URL normalizer
  shared with the catalog identity on both sides; pointer rows never count as
  overlap or grantflow_only (a directory admitted to the catalog cannot change
  parity — asserted); a closed disposition vocabulary persisted for every
  web-only result and on each gap-queue candidate; `gated_out` only on a
  recorded gate verdict, extraction outages become `not_evaluated:*` and stay
  re-seedable; semantics v4; `backend/scripts/web-parity-replay.mjs`.
- Hamilton — verifier writes the same evidence keys as the live path; a
  declared receipt-URL landing is proof only with retained bytes; the failed-
  click park uses a CAS from the real state and an uncertain click stays
  parked (never retried); proof documents no longer dedupe across tasks;
  automation-off / complete_forms-not-granted decided before any run row and
  left as durable reasons; policy 503 defers the source; every handoff kind
  asserts its resumable state; DOM slugs are never confirmation references;
  `backend/scripts/hamilton-durable-confirmations.mjs` is the authoritative
  durable count through the predicate (production: 44 submitted rows, 0
  durable — the fixes change future writes, they relabel nothing).
- Agent control — terminal `blocked` status accepted by both schemas
  (`schema.sql` + PG migration 1006); a preflight block emits one admin
  notice.
- Discovery telemetry (`webLane.js`, `webGrantExtractor.js`,
  `coverageAudit/*`, `samRegistry.js`, owner digest) — `result.queries` is the
  EXECUTED list; `query_ledger` (planned with tiers / executed / skipped_budget
  / skipped_duplicate), `stage_ledger` with the exact counters
  `query_generated … qualified_admitted` plus `extraction_failed` by class,
  bounded `page_ledger`, `seed_outcomes`, `provider_health`; the extractor
  surfaces its failure class instead of returning `[]`; pure
  `attributePrimaryGap()` gives every gap ONE primary attribution
  (`extraction_failed:<class>`, `provider_unavailable`,
  `query_budget_truncation`, `gate_rejected:<gate>`, `under_result_target`,
  `healthy_no_results`, `no_crawl`); `result_floor_shortfall` and
  `low_results` are no longer double-counted; day buckets carry the trigger
  population; an empty 7-day window says so instead of falling back to
  lifetime; `extraction_dead` is a distinct lane verdict; every Sam coverage
  check and the digest carry the metric envelope and the scoreboard can never
  close the 7-day window (`canCloseRegression`).
- Regressions caught by bisecting against clean `origin/main` and fixed:
  the approval ledger's import of `intersectionScenario` dragged
  `probeSpace`'s import-time `profileHelpers` read into unrelated graphs
  (constant moved to `amyConstants.js`); the cross-profile REVIEW test's
  fixture had only read as REVIEW because declared needs used to be dropped.

## Verification and honest status

_(filled in at integration: exact commands, CI runs, deployed SHAs, post-fix
cohort / parity / coverage numbers, EVA run id.)_

## Traps learned

- Launching `eva-bootstrap.ps1` from a pwsh 7 session inherits pwsh's
  `PSModulePath` and Windows PowerShell 5.1 then cannot find `Get-FileHash`;
  run it through `cmd.exe` with the three native 5.1 module dirs.
- The scheduled EVA task captures no stdout and the TaskScheduler operational
  log is disabled on this host — a task exit code 1 is unrecoverable after the
  fact.
- An EVA run on a saturated host (100% CPU) misses startup deadlines for
  GrantFlow, SermonSmith, repo-rewards and Incognito; it must not be used to
  open or close startup findings.
- `Claude Code` session/credit limits kill background workflow agents
  mid-edit; the worktree keeps their partial edits — audit `git diff` before
  resuming.
