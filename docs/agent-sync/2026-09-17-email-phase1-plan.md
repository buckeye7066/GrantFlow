# September 17 email: Phase 1 implementation plan

**Goal:** separate current failures from stale evidence, then repair the obsolete Factory Deck journey without restoring a removed demo mode.
**Architecture:** GrantFlow owns the portfolio QA manifest; local-ai-factory owns the UI. Change only the manifest and its regression test. Preserve the historical journey ID so the next real run can record the replacement contract explicitly.
**Stack:** Node test runner, JSON manifests, existing Playwright adapter.
**Spec:** owner's September 17 daily-report attachment; local-ai-factory commit 95cb1a8 / PR #209 deliberately removes offline demo mode.

## Constraints
- No crawler admission, eligibility, geography, result floors, or source-proof gates change in this phase.
- No Factory run, AI request, publication, configuration change, or production database write is permitted by the read-only journey.
- Keep readiness/startup checks; do not count shell presence as successful app generation.
- Distinguish local tests, remote CI, merge, runner execution, and production closure.

## Steps
- [x] Read current main and email evidence; locate both application repositories and QA ownership.
- [x] Check GrantFlow production provider health and recent adapter / extraction records without changing records.
- [x] Baseline: `node --test tools/eva-edge-runner/test/manifests.test.mjs` passes 72 tests on 508b81fc.
- [x] Replace obsolete test expectation with required current New Run fields, start control, and an explicit detached-state assertion for the removed demo checkbox; run tests and observe failure on the unchanged manifest.
- [x] Update `qa/manifests/factory-deck.json`: wait for `#repo-name`, `#idea`, and `button:has-text("Start Factory Run")`, then require the old demo checkbox to be detached. Keep all steps read-only and keep the existing journey ID.
- [x] Run manifest and complete EVA tests; exercise the real Factory UI without starting a run. Verify the absence check also rejects a page containing the old checkbox.
- [ ] Review exact diff, create PR, wait for required checks, merge through the repository guard, sync main, and rerun the targeted signed Factory Deck journey.

## Current production findings (not permanent closure)
At 2026-09-17T17:20:41Z a fresh in-container provider probe reported healthy SearXNG (bing/seznam/yandex) and Brave HTTP 200. Other SearXNG engines still report suspensions. The latest ten recorded Federal Register adapter runs had no fetch error; the Amy error was HTTP 500, not evidence of a missing API key. The latest eight inspected web-lane records had healthy extraction with partial timeouts, not quota failures. Intermittent search degradation and all downstream coverage findings remain open until representative reruns prove recovery.

## Repository / phase ledger
The email contains four GrantFlow headline findings and one Factory Deck journey finding, plus overlapping subcategories. Counts below must not be added as distinct failures.

| Phase | Affected app / owning repository | Categories from the email | Closure evidence |
| --- | --- | --- | --- |
| 1 | GrantFlow / GrantFlow | Degraded search; historical llm_quota extraction attribution (660); discovery blocked by provider degradation (1 synthetic profile); Federal Register source_fetch_failed and adapter_source_health | Current provider and adapter checks plus representative healthy reruns. A current healthy probe does not erase seven-day failures. |
| 1 | Factory Deck / GrantFlow QA manifest; UI in local-ai-factory | Repeated timeout looking for an intentionally removed Offline demo checkbox; six occurrences | Regression red/green; real current UI passes the replacement read-only contract; signed EVA run records the result. Do not restore demo mode. |
| 2 | GrantFlow / GrantFlow | Golden outcome missing usa_gov_local_governments; two qualifies admission escapes; eligibility rejection attribution (263); apply-target rejection attribution (213) | Replay concrete candidates through canonical admission, persist/readback, and cleanup. Legitimate sources remain available without turning directories into fabricated application links. No out-of-state candidate escapes. |
| 3 | GrantFlow / GrantFlow | result_floor_shortfall (1844), low_results (766), hyperlocal_gap (496), under_result_target (95); verified query-breadth investigation for graduate_student, chronic_illness_patient, disabled_person; six named provider-blocked archetypes plus 101 omitted gaps | Same-profile before/after stage ledgers with healthy provider provenance; missing subjects demonstrably recovered as qualified useful results. Query-builder guilt is not presumed. |
| 4 | GrantFlow / GrantFlow | Amy cohort: 0/49 clean of target 50; hyperlocal_recall_miss (45), no_qualified_matches (5), source_fetch_failed (1); insufficient trend history; repeated lessons without outcome closure | All 50 accounted for, failed and unevaluated separated, healthy cohort rerun, synthetic TTL verification, complete retained evidence and closure only when the finding stops reproducing. |
| 5 | GrantFlow / GrantFlow | Web-parity regression 18.2 vs 33.3 (-15.1); nine web-only results per golden profile; queued benchmark seeds not yet proved admitted; 1,146 unattributed crawl triggers | Comparable benchmark reruns; seed-to-admission evidence and correct primary sites; trigger attribution and same-population/time-window reporting. The prior baseline is only one run. |
| 5 | Factory Deck / local-ai-factory + GrantFlow runner | Verification limitation: one shell journey is not app generation; portfolio coverage is 32% despite 67/68 passing | Keep the untested workflows explicit. Do not turn a shell pass into a production-ready claim or claim all 19 apps are fully covered. |

## Not new repair items
- The Factory Deck startup/readiness finding is already resolved; keep its regression check.
- Planner zero gaps across 24 profiles is a different metric from the seven-day 1869/1955 result-gap rate; the email already states this correctly.
- Eight closed approvals and zero expired synthetic profiles are not open failures.
- Four steering lessons, 44 adversarial probes, and consumed agent messages are activity, not proof that coverage improved.
- Async/configurable scraping competitor suggestions have no measured superiority; they are not approved repairs.
- The omitted fifth code item was recovered from the current Amy queue: pipeline_guard_escape / eligibility_gate, candidate backend/services/opportunityMatcher.js:244. The concrete audit described a persisted out-of-state restriction escaping two Tennessee pipelines. Root cause is not yet established.

## Sequence
Finish Phase 1 verification and the QA-contract correction, then Phase 2 admission/golden replay, Phase 3 discovery repair, Phase 4 Amy evidence, and Phase 5 comparative validation. No later phase is marked complete by this plan or by unit-test success alone.

## Verified before PR
- Regression red: unchanged manifest produced 71 passes / 1 assertion failure (`#repo-name` missing from the declared journey); green: 72/72.
- Complete EVA runner suite: 172/172, zero skipped/cancelled/failures.
- Real isolated Factory Deck main e3798bb: app-identifies-itself passed and replacement demo-mode-visible passed; no Factory run started.
- Browser mutation controls: current form passes; a reintroduced offline-demo checkbox fails; a blank page fails.
- No Factory Deck application code changed: the defect is the centrally owned obsolete test contract.
