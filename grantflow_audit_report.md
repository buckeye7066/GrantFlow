# FlexFactor audit — GrantFlow

- **Project:** `C:\Users\firer\GrantFlow`
- **Branch:** `main`
- **Toolchains:** java, node, swift
- **Build verification:** NOT AVAILABLE — dependencies not installed for swift:ios/App/CapApp-SPM - build gate would false-fail. Fixes in this run were NOT build-verified.
- **Dependency bootstrap:** 1/2 install step(s) succeeded — a failed install can make the build gate red for reasons unrelated to the code
- **Files reviewed:** 2 of 3597 candidate(s)
- **FILE ACCOUNTING: 3597 candidate(s) = 2 reviewed + 3565 never_attempted + 30 review_incomplete**
- **MOSTLY SKIPPED: only 2 of 3597 candidate file(s) (0%) were reviewed.**
- **Defects found:** 7
- **Files fixed:** 1
- **No-ops:** 1 (none are successes) — **0 rejected finding(s)** (author found nothing to fix — a REVIEW-precision defect, not a fix failure), **0 no fix found** (a real defect the loop could not land), 1 unclassified (the note did not say)
- **Errors recorded:** 29 (see the Errors section below; ledger at `C:\Users\firer\.flexfactor\runs\grantflow-20260826-173358-556165-36728\errors.md`)
- **Baseline build:** passed
- **Unit tests added:** 0 (suite not run)
- **Button/UI (Playwright):** skipped
- **Cycles run:** 1
- **Providers:** rotation:liquid/lfm-2.5-2.6b:free
- **Git:** PROVIDER-OUTAGE ABORT on main: checkpoint preserved; no unverified commit created

## System inventory

**171510 entries accounted for.**

| Category | Count |
|---|---:|
| artifact-subtree | 50 |
| binary-asset | 1839 |
| configuration-documentation-or-data | 18305 |
| first-party-source | 151305 |
| reparse-directory | 11 |

The immutable run manifest contains the complete path-level inventory. Artifact, binary, and reparse entries are named and classified; they are not represented as line-reviewed source.

## Executable evidence

- **Evidence run:** `grantflow-20260826-173358-556165-36728`
- **Exact final commit:** `0a05bac5a68c5437656f7dfe113f64be484c6608`
- **Code map:** 4200 file(s), 18878 function(s), 1261 route(s), 3832 material control(s)
- **Function execution:** 0/16243 with invocation evidence
- **Route execution:** 0/1261
- **Control execution:** 0/3832
- **Changed-file rescan:** 1/1 (complete)
- **Blast radius:** 1 affected file(s); analysis ran
- **Normalized gates:** 3 pass, 3 fail, 3 blocked

- **Blast Radius:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-173358-556165-36728\blast-radius.json`
- **Changed File Rescan:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-173358-556165-36728\changed-file-rescan.json`
- **Code Index:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-173358-556165-36728\code-index.json`
- **Coverage Ledger:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-173358-556165-36728\coverage-ledger.json`
- **Manifest:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-173358-556165-36728\manifest.json`
- **Purpose Graph:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-173358-556165-36728\purpose-graph.json`
- **Quality Gates:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-173358-556165-36728\quality-gates.json`
- **Sarif:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-173358-556165-36728\results.sarif`

## Production readiness

**NOT PRODUCTION READY** — 11/15 evaluated gates passed, 6 blocker(s).

Full scorecard: `C:\Users\firer\GrantFlow\grantflow_readiness.md`

- **Changes can be build-verified** [critical] — dependencies not installed for swift:ios/App/CapApp-SPM - build gate would false-fail
  - Fix: Install dependencies and ensure a build/check command exists; without one no fix in this repo can be proven safe.
- **Project builds** [critical] — build was not run
  - Fix: Run the detected build command and fix the errors.
- **Test suite passes** [high] — tests were not run
  - Fix: Run the suite and fix failures.
- **Dependencies are lock-pinned** [high] — no lockfile: java:android, java:android/app, java:android/capacitor-cordova-android-plugins
  - Fix: Commit the lockfile so builds are reproducible.
- **User-facing entities persist beyond in-memory stubs** [high] — in-memory stub: backend/routes/grantScopedRecords.js (createStubEntityClient/in-memory stub), backend/routes/orgScopedRecords.js (createStubEntityClient/in-memory stub)
  - Fix: Replace createStubEntityClient / KNOWN_STUB_ENTITIES with a real persist path. A named user-facing entity that only lives in a Map (toast-then-vanish) is not production-ready.
- **Fresh-DB schema bootstrap covers migrated tables** [high] — fresh-DB miss: ingestion_runs (backend/db/migrations/001_add_ingestion_support.sql), crawler_jobs_new (backend/db/migrations/003_add_national_crawl_and_contact_info.sql), audit_logs (backend/db/migrations/004_audit_logs.sql), reviews (backend/db/migrations/008_add_reviews.sql), source_directory (backend/db/migrations/011_add_source_directory.sql)
  - Fix: Add new tables to the fresh-DB schema.sql (or an IF NOT EXISTS extras file applied after it: workspacePersistenceTables / ensureSqliteSchema / applyWorkspace) AND ship the Postgres twin when backend/db/postgres/migrations exists. A hidden `npm run migrate` must not be required to create them.

## Competitor research

**Coverage:** 5 competitor(s) covered with corroborating sources (target 5).

- **Sources used:** web:duckduckgo, github, repo-rewards
- **Repo Rewards endpoint:** `https://web-production-d7db7.up.railway.app`
- **Sources SKIPPED (named, not silent):**
  - `idea:CiviCRM` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for CiviCRM
  - `idea:Smartsheet` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for Smartsheet
  - `web:searxng` - RuntimeError: FLEXFACTOR_SEARXNG_URL is not set

- **Ideas accepted as serving this program's purpose:** 3 (rejected 2 - the purpose contract, not the competitor, decides)

- **Bridged into the fix stream:** 0 of 5 candidate(s)
  - NOT bridged (3): GrantStation, Grantwatch, OpenGrantStack/GrantReady-hub-SaaS - accepted idea did not map to a valid acceptance criterion
  - NOT bridged (2): CiviCRM, Smartsheet - idea rejected by the purpose contract

| Competitor | Kind | Licence | Reuse mode | Purpose mapping | Verdict | Fix stream | Adoptable idea |
|---|---|---|---|---|---|---|---|
| [CiviCRM](https://github.com/civicrm/civicrm-core) | oss | `AGPL-3.0` | `clean-room-from-documented-behavior` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [Smartsheet](https://github.com/smartsheet-platform/smartsheet-python-sdk) | oss | `Apache-2.0` | `direct-code-reuse` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [OpenGrantStack/GrantReady-hub-SaaS](https://github.com/OpenGrantStack/GrantReady-hub-SaaS) | oss | `Apache-2.0` | `direct-code-reuse` | acceptance #authenticated end-to-end journey | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Approval Workflow Module |
| [GrantStation](https://github.com/jderrod/GrantStationTool) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | acceptance #1, 10 | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Clean-room design of automated matching based on documented behavior |
| [Grantwatch](https://github.com/jnhemley/grantwatch) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | acceptance #real output comparison against manual search | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | External-Only Crawler with Source-Directory Separation |

### CiviCRM

- **Evidence:** <https://github.com/civicrm/civicrm-core>, <https://github.com/civicrm/civicrm-wordpress>
- **Licence:** `AGPL-3.0` (via github-api)
- **Reuse mode:** `clean-room-from-documented-behavior` - licence AGPL-3.0 is copyleft/restricted; source must NOT be copied - work from documented behaviour only
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### Smartsheet

- **Evidence:** <https://github.com/smartsheet-platform/smartsheet-python-sdk>
- **Licence:** `Apache-2.0` (via github-api)
- **Reuse mode:** `direct-code-reuse` - licence Apache-2.0 is permissive and compatible; source may be read and adapted with attribution
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### OpenGrantStack/GrantReady-hub-SaaS

- **Evidence:** <https://github.com/OpenGrantStack/GrantReady-hub-SaaS>
- **Licence:** `Apache-2.0` (via repo-rewards)
- **Reuse mode:** `direct-code-reuse` - licence Apache-2.0 is permissive and compatible; source may be read and adapted with attribution
- **Idea:** Approval Workflow Module - Provides a role-based, traceable approval process for grant applications, with notifications and audit logs.
- **Value here:** Adds structured review steps to GrantFlow's pipeline, ensuring provenance, preventing overstatement, and supporting authenticated end-to-end application journeys.
- **Purpose / criterion mapping:** acceptance #authenticated end-to-end journey - An approval workflow integrates directly into the whole-profile funding discovery and application workflow, helping preserve provenance and ensure honest handling of applications, thus advancing GrantFlow's stated purpose.
- **Purpose verdict:** ACCEPTED - An approval workflow integrates directly into the whole-profile funding discovery and application workflow, helping preserve provenance and ensure honest handling of applications, thus advancing GrantFlow's stated purpose.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** Competitor description states the platform enables secure collaboration and approval workflows for grant management teams. (confidence medium)

### GrantStation

- **Evidence:** <https://github.com/jderrod/GrantStationTool>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** Clean-room design of automated matching based on documented behavior - The competitor provides matching/scoring of grant opportunities against user profiles using documented public behavior, without requiring inspectable source code, enabling algorithmic transparency and third-party verification.
- **Value here:** GrantFlow's acceptance criteria require 'one authoritative matching/scoring contract' and 'real output comparison against manual search'. A clean-room matching engine built from documented behavior would directly satisfy these criteria while preserving provenance and enabling comparison to manual baselines.
- **Purpose / criterion mapping:** acceptance #1, 10 - Adopting this idea advances the program's stated purpose by delivering the authoritative matching/scoring contract required by acceptance criteria 1 and enabling the real-output comparison required by criterion 10, without overstating qualification.
- **Purpose verdict:** ACCEPTED - Adopting this idea advances the program's stated purpose by delivering the authoritative matching/scoring contract required by acceptance criteria 1 and enabling the real-output comparison required by criterion 10, without overstating qualification.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** Competitor repo is not inspectable (license UNKNOWN); only publicly documented behavior may inform design per the reuse mandate. The competitor's matching capability is established by its documented public behavior, not source code. (confidence medium)

### Grantwatch

- **Evidence:** <https://github.com/jnhemley/grantwatch>, <https://github.com/skyfallwastaken/grantwatcher>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** External-Only Crawler with Source-Directory Separation - A crawler that scans the open internet for grant listings and explicitly separates found sources into a 'source directory' distinct from the program's own curated profile database, allowing users to view, trace, and manually act on external opportunities without importing them.
- **Value here:** Enables the 'real output comparison against manual search' acceptance criterion and the 'authenticated end-to-end journey' by providing a verifiable external feed to compare against, while keeping the internal profile database untouched for provenance and duplicate handling.
- **Purpose / criterion mapping:** acceptance #real output comparison against manual search - Adopting this idea directly serves the program's stated purpose of 'finding real current profile-specific official sources' and the acceptance criterion 'real output comparison against manual search'. It also supports 'current-source validation' and 'authenticated end-to-end journey' by giving users a trusted external reference to validate internal results against.
- **Purpose verdict:** ACCEPTED - Adopting this idea directly serves the program's stated purpose of 'finding real current profile-specific official sources' and the acceptance criterion 'real output comparison against manual search'. It also supports 'current-source validation' and 'authenticated end-to-end journey' by giving users a trusted external reference to validate internal results against.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** The competitor repository at https://github.com/jnhemley/grantwatch is documented as an external crawler; the audited program's folder contains many source-registry and crawl files (src/api/crawlers.js, src/pages/CrawlCoverage.jsx, etc.) but lacks a publicly documented separation between external-found sources and internal profile sources. (confidence medium)

## Release status

**BLOCKED**

Status vocabulary is the owner's (master prompt section 4). `DONE` is not a release status, and none of these are equivalent to PRODUCTION READY: tests pass, build passes, merged, deployed, health endpoint returns 200, works locally, PR opened.

Standing between this program and PRODUCTION READY (20 condition(s) without passing evidence):

- `purpose_fulfilled` — The core purpose is fully implemented and the purpose-defining journey produces the outcome the program exists to produce.
- `journeys_end_to_end` — Primary user journeys work end to end.
- `modes_behave` — Major roles, modes, controls and configuration choices materially change behavior as intended.
- `data_paths` — Production data paths are functional and protected.
- `authz` — Authentication and authorization are correct.
- `privacy_security` — Privacy and security controls are appropriate.
- `defects_resolved` — Critical and high-severity defects are resolved.
- `tests_pass` — Applicable tests pass, on full rather than selectively narrowed gates.
- `reviewed` — The complete release candidate received substantive review.
- `merged` — Required changes are merged to the verified default branch.
- `ci_on_sha` — CI passes on the exact final default-branch SHA.
- `sha_deployed` — The exact merge SHA is deployed, packaged, or installed.
- `release_identity` — Live or installed release identity is independently verified.
- `output_inspected` — The actual purpose-defining production journey was executed and its final output inspected.
- `observability` — Monitoring, logging and error reporting are operational and do not expose secrets.
- `recovery_docs` — Backup, rollback, upgrade, uninstall and recovery documentation exists and was tested where applicable.
- `claims_match` — Product claims match verified capabilities.
- `no_abandoned_work` — No production-required work is abandoned in another PR, branch, worktree, or local artifact.
- `user_understandable` — The application is understandable to its intended users without developer assistance.
- `no_external_gap` — No required credential, certificate, legal review, payment validation, or external production proof remains incomplete.

## Runtime-data evidence (read-only production)

**UNAVAILABLE** - FLEXFACTOR_READONLY_DATABASE_URL is not set - FlexFactor has NO read path to production data, so NO data-shaped or environment-shaped root cause could be looked for (this is not evidence that none exists)

_This is NOT a clean data bill of health: no data-shaped or environment-shaped root cause could be looked for._

## Remaining defects NOT auto-fixed (fix floor = medium)

_These were found but left as-is - review and decide. Critical/high here means a file that could not be safely auto-fixed (see manual-review list)._

### high (1)
- `(purpose)` line 0 (quality-gate) - **Purpose assessment evidence is incomplete**: baseline purpose assessment incomplete: 1/3 sample(s) usable; RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expected one of ['purpose', 'fulfillment_pct', 'gaps']); len=2 head='{}'; HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20356 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":20356,"n_ctx":16384}}; final purpose assessment returned no usable result _Suggested fix:_ Retry the resumable run after restoring a responsive provider.

## Defects by file

_No defects found in the reviewed files._

## Fix notes / left unfixed

- src/main.jsx: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- src/main.jsx: no verified candidate was produced
- tests/unit/admin-integrity-repair.test.mjs: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- tests/unit/admin-integrity-repair.test.mjs: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: The dynamic import() of @capacitor/core will not move the module into another chunk because it's also statically imported by several capacitor packages. Moving the import to top-level and guarding with typeof window check fixes the code-splitting issue. The original .then/.catch wrapper is preserved functionally but restructured to top-level import with a runtime guard.
- tests/unit/admin-integrity-repair.test.mjs: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- tests/unit/admin-integrity-repair.test.mjs: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: no verified candidate was produced
- tests/unit/admin-integrity-repair.test.mjs: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: no verified candidate was produced
- publication failure made no progress and did not name another repairable source file
- baseline publication suite is red and bounded repair did not fix it; review continued, publication stays blocked
- src/api/crawlers.js: NO-OP - author model returned no change for 1 finding(s): The defect requires adding a link-status validation function and integrating it into link lifecycle processing, but the file src/api/crawlers.js does not contain any link processing logic. Therefore, the fix must be implemented in a different file that handles link processing (e.g., where crawler results are processed or where links are extracted).
- review made no progress: three consecutive semantic review batches completed ZERO files (2 of 3597 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
- rollback failed; working tree requires inspection


## Errors (29)

| # | phase | kind | error | responsible |
|---|---|---|---|---|
| 1 | fix | budget | no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/public-source-profile-privacy.test.mjs |
| 2 | fix | budget | no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-ti | src/main.jsx |
| 3 | fix | budget | no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/admin-integrity-repair.test.mjs |
| 4 | fix | budget | no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/public-source-profile-privacy.test.mjs |
| 5 | fix | budget | no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-ti | src/main.jsx |
| 6 | baseline | program-defect | baseline publication suite is RED and bounded targeted repair did not fix it | - |
| 7 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 8 | rotation | budget | RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your c | flexfactor.py:2412 |
| 9 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 10 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 11 | rotation | provider | HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20356 tok | flexfactor.py:2763 |
| 12 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 13 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 14 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request Entity Too Large', 'type' | flexfactor.py:2412 |
| 15 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 16 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 17 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 18 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 19 | rotation | provider | RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expect | flexfactor.py:3048 |
| 20 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 21 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 22 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 23 | rotation | provider | PermissionDeniedError: Error code: 403 - {'error': {'message': 'thinkingmachines/inkling:f | flexfactor.py:2412 |
| 24 | rotation | provider | PermissionDeniedError: Error code: 403 - {'error': {'message': 'thinkingmachines/inkling-s | flexfactor.py:2412 |
| 25 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 26 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 27 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 28 | rotation | provider | RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expect | flexfactor.py:3048 |
| 29 | baseline-gate | program-defect | review made no progress: three consecutive semantic review batches completed ZERO files (2 | - |

Counts by kind: budget 6, program-defect 2, provider 21

### 1. fix — budget

**Error**

```
no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/public-source-profile-privacy.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 2. fix — budget

**Error**

```
no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `src/main.jsx`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 3. fix — budget

**Error**

```
no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/admin-integrity-repair.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 4. fix — budget

**Error**

```
no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/public-source-profile-privacy.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 5. fix — budget

**Error**

```
no strong route available (119 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `src/main.jsx`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 6. baseline — program-defect

**Error**

```
baseline publication suite is RED and bounded targeted repair did not fix it
```

**Detail**

```
✔ runYanaDiscovery surfaces prospect funnel in the summary (32.9858ms)
✔ YANA_TARGET_AREAS focuses OSM anchors + ProPublica states (owner geographic focus) (7.2698ms)
✔ caller-pinned per-source geography WINS over target areas (2.6867ms)
ℹ tests 3089
ℹ suites 129
ℹ pass 3088
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 572604.0277

✖ failing tests:

test at tests\unit\public-source-profile-privacy.test.mjs:199:1
✖ public source tree contains no known real-profile identifier or full-name marker (22299.2758ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
  + [
  +   'grantflow_audit_report.md:3: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T053800755390.json:24265: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T114803768100.json:24253: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T164822778819.json:24253: private Windows account or mailbox alias'
  + ]
  - []
  
      at TestContext.<anonymous> (file:///C:/Users/firer/GrantFlow/tests/unit/public-source-profile-privacy.test.mjs:218:10)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'grantflow_audit_report.md:3: private Windows account or mailbox alias', 'grantflow_run_manifest_20260826T
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (signature)

Read the full log at C:\Users\firer\.flexfactor\runs\grantflow-20260826-173358-556165-36728\baseline-publication-failure.log. Publication (push/merge) stays refused while the baseline is red; the review still runs.

### 7. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '7fadd4de-e22a-48e4-90e9-f02ef14a74b9': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/mistralai/mistral-large-2-instruct`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 8. rotation — budget

**Error**

```
RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\nPlease retry in 17.800329711s.', 'status': 'RESOURCE_EXHAUSTED', 'details': [{'@type': 'type.googleapis.com/google.rpc.Help', 'links': [{'description': 'Learn more about Gemini API quotas', 'url': 'https://ai.google.dev/gemini-api/docs/rate-limits'}]}, {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [{'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests', 'quotaId': 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'quotaDimensions': {'model': 'gemini-3.1-pro', 'location': 'global'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests', 'quotaId': 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'quotaDimensions': {'location': 'global', 'model': 'gemini-3.1-pro'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', 'quotaId': 'GenerateContentInputTokensPerModelPerMinute-FreeTier', 'quotaDimensions': {'location': 'global', 'model': 'gemini-3.1-pro'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', 'quotaId': 'GenerateContent
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `gemini/gemini-3.1-pro-preview-customtools`

**Suggested fix** (signature)

The account's FREE DAILY allowance for that backend is spent - one allowance, however many models the catalog lists under it. FlexFactor now benches the whole allowance until the reset the provider named (X-RateLimit-Reset) instead of re-testing it every 60s, and the run continues on other backends. It returns by itself at the daily reset; do not add paid credit to compensate. If a run must not depend on it, point the run at a backend with headroom rather than waiting.

### 9. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19708, Requested 23688. Please try again in 26.792s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 10. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/gpt-oss:20b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 11. rotation — provider

**Error**

```
HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20356 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":20356,"n_ctx":16384}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2763` in `_chat()`

```python
raise enriched from http_exc
```
- Route: `ollama/deepseek-r1:8b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 12. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/gemma4:26b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 13. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '23d4f03a-b8a6-4adb-a183-7daa083a09cc': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/moonshotai/kimi-k2.6`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 14. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request Entity Too Large', 'type': 'invalid_request_error', 'code': 'request_too_large'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound-mini`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 15. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/gemma4:e4b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 16. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': 429, 'metadata': {'raw': 'z-ai/glm-5.2:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations', 'provider_name': 'Decart', 'is_byok': False, 'provider_error_code': 'upstream_429', 'limit_source': 'upstream_provider_shared_pool', 'remedy_hint': 'Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing', 'retry_after_seconds': 5, 'retry_after_seconds_raw': 5, 'headers': {'Retry-After': '5'}}}, 'user_id': 'user_3GWU0JMa1TcZebCavX9qtXxTXSU'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/z-ai/glm-5.2:free`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 17. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': 429, 'metadata': {'raw': 'poolside/laguna-s-2.1:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations', 'provider_name': 'Poolside', 'is_byok': False, 'limit_source': 'upstream_provider_shared_pool', 'remedy_hint': 'Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing'}}, 'user_id': 'user_3GWU0JMa1TcZebCavX9qtXxTXSU'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/poolside/laguna-s-2.1:free`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 18. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': 429, 'metadata': {'raw': 'poolside/laguna-xs-2.1:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations', 'provider_name': 'Poolside', 'is_byok': False, 'limit_source': 'upstream_provider_shared_pool', 'remedy_hint': 'Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing'}}, 'user_id': 'user_3GWU0JMa1TcZebCavX9qtXxTXSU'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/poolside/laguna-xs-2.1:free`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 19. rotation — provider

**Error**

```
RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expected one of ['purpose', 'fulfillment_pct', 'gaps']); len=2 head='{}'
```

**Responsible code**

- FlexFactor `flexfactor.py:3048` in `_check_structured_type()`

```python
raise RuntimeError(
```
- Route: `openrouter/openrouter/free`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 20. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/phi4-mini:latest`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 21. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': 429, 'metadata': {'raw': 'google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations', 'provider_name': 'Google AI Studio', 'is_byok': False, 'provider_error_code': '429', 'limit_source': 'upstream_provider_shared_pool', 'remedy_hint': 'Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing'}}, 'user_id': 'user_3GWU0JMa1TcZebCavX9qtXxTXSU'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/google/gemma-4-31b-it:free`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 22. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': 429, 'metadata': {'raw': 'google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations', 'provider_name': 'Google AI Studio', 'is_byok': False, 'provider_error_code': '429', 'limit_source': 'upstream_provider_shared_pool', 'remedy_hint': 'Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing'}}, 'user_id': 'user_3GWU0JMa1TcZebCavX9qtXxTXSU'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/google/gemma-4-26b-a4b-it:free`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 23. rotation — provider

**Error**

```
PermissionDeniedError: Error code: 403 - {'error': {'message': 'thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps', 'code': 403}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/thinkingmachines/inkling:free`

**Suggested fix** (signature)

This route is gated or not permitted for the key in use. Rotation skips it after strikes; to stop retrying it, exclude it (FLEXFACTOR_ROTATION_EXCLUDE=<fragment>) or have AI Time's catalog mark it disabled.

### 24. rotation — provider

**Error**

```
PermissionDeniedError: Error code: 403 - {'error': {'message': 'thinkingmachines/inkling-small:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps', 'code': 403}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/thinkingmachines/inkling-small:free`

**Suggested fix** (signature)

This route is gated or not permitted for the key in use. Rotation skips it after strikes; to stop retrying it, exclude it (FLEXFACTOR_ROTATION_EXCLUDE=<fragment>) or have AI Time's catalog mark it disabled.

### 25. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': 429, 'metadata': {'raw': 'minimax/minimax-m2.7:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations', 'provider_name': 'GMICloud', 'is_byok': False, 'provider_error_code': 'rate_limit_exceeded', 'limit_source': 'upstream_provider_shared_pool', 'remedy_hint': 'Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing', 'retry_after_seconds': 60, 'retry_after_seconds_raw': 60, 'headers': {'Retry-After': '60'}}}, 'user_id': 'user_3GWU0JMa1TcZebCavX9qtXxTXSU'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/minimax/minimax-m2.7:free`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 26. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `openrouter/minimax/minimax-m3:free`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 27. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/mistral:latest`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 28. rotation — provider

**Error**

```
RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expected one of ['suggestion']); len=333 head='{"type":"object","properties":{"suggestion":{"type":"string"},"suggestion":"Evidence insufficient - no file, line, or stack trace provided. The error describes a provider/route fault in a review pipel'
```

**Responsible code**

- FlexFactor `flexfactor.py:3048` in `_check_structured_type()`

```python
raise RuntimeError(
```
- Route: `openrouter/dots-studio/dots-3-note-preview:free`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 29. baseline-gate — program-defect

**Error**

```
review made no progress: three consecutive semantic review batches completed ZERO files (2 of 3597 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (model)

model suggestion, unverified: The error indicates a provider/route fault where zero files were reviewed out of 3597 candidates, suggesting a systemic issue in the review pipeline rather than a code problem. Without specific file paths or line numbers from the stack trace, I cannot identify a precise location to fix. The most likely cause is misconfiguration in the review service itself (e.g., incorrect file filtering, routing failure, or provider endpoint down), which should be investigated by checking the infrastructure logs and configuration for the semantic review system before attempting any code changes.