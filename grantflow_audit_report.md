# FlexFactor audit — GrantFlow

- **Project:** `C:\Users\firer\GrantFlow`
- **Branch:** `main`
- **Toolchains:** java, node, swift
- **Build verification:** NOT AVAILABLE — dependencies not installed for swift:ios/App/CapApp-SPM - build gate would false-fail. Fixes in this run were NOT build-verified.
- **Dependency bootstrap:** 1/2 install step(s) succeeded — a failed install can make the build gate red for reasons unrelated to the code
- **Files reviewed:** 0 of 3597 candidate(s)
- **FILE ACCOUNTING: 3597 candidate(s) = 0 reviewed + 3573 never_attempted + 24 review_incomplete**
- **ZERO WORK: not one of 3597 candidate file(s) was reviewed. This run did nothing; treat it as a FAILURE, not a clean repo.**
- **Defects found:** 7
- **Files fixed:** 0
- **Errors recorded:** 16 (see the Errors section below; ledger at `C:\Users\firer\.flexfactor\runs\grantflow-20260826-012727-565462-5432\errors.md`)
- **Baseline build:** passed
- **Unit tests added:** 0 (suite not run)
- **Button/UI (Playwright):** skipped
- **Cycles run:** 1
- **Providers:** rotation:allam-2-7b
- **Git:** PROVIDER-OUTAGE ABORT on main: checkpoint preserved; no unverified commit created

## System inventory

**171467 entries accounted for.**

| Category | Count |
|---|---:|
| artifact-subtree | 50 |
| binary-asset | 1827 |
| configuration-documentation-or-data | 18283 |
| first-party-source | 151296 |
| reparse-directory | 11 |

The immutable run manifest contains the complete path-level inventory. Artifact, binary, and reparse entries are named and classified; they are not represented as line-reviewed source.

## Executable evidence

- **Evidence run:** `grantflow-20260826-012727-565462-5432`
- **Exact final commit:** `46f6a72f3536cbfaba52a3887fb638f700933da3`
- **Code map:** 4197 file(s), 18878 function(s), 1261 route(s), 3832 material control(s)
- **Function execution:** 0/16243 with invocation evidence
- **Route execution:** 0/1261
- **Control execution:** 0/3832
- **Changed-file rescan:** 1/1 (complete)
- **Blast radius:** 1 affected file(s); analysis ran
- **Normalized gates:** 3 pass, 3 fail, 3 blocked

- **Blast Radius:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-012727-565462-5432\blast-radius.json`
- **Changed File Rescan:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-012727-565462-5432\changed-file-rescan.json`
- **Code Index:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-012727-565462-5432\code-index.json`
- **Coverage Ledger:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-012727-565462-5432\coverage-ledger.json`
- **Manifest:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-012727-565462-5432\manifest.json`
- **Purpose Graph:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-012727-565462-5432\purpose-graph.json`
- **Quality Gates:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-012727-565462-5432\quality-gates.json`
- **Sarif:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-012727-565462-5432\results.sarif`

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
  - `idea:Fluxx Grant Management` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for Fluxx Grant Management
  - `idea:Quazi-07/Research-Grant-Finder-Agent` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for Quazi-07/Research-Grant-Finder-Agent
  - `idea:Quazi-07/Research-Grant-Finder-Agent-V2.0` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for Quazi-07/Research-Grant-Finder-Agent-V2.0
  - `idea:RockefellerArchiveCenter/fluxx_exporter` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for RockefellerArchiveCenter/fluxx_exporter
  - `idea:ritchiea/recessart` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for ritchiea/recessart
  - `web:searxng` - RuntimeError: FLEXFACTOR_SEARXNG_URL is not set

- **Ideas accepted as serving this program's purpose:** 0 (rejected 5 - the purpose contract, not the competitor, decides)

- **Bridged into the fix stream:** 0 of 5 candidate(s)
  - NOT bridged (5): Fluxx Grant Management, Quazi-07/Research-Grant-Finder-Agent, Quazi-07/Research-Grant-Finder-Agent-V2.0, RockefellerArchiveCenter/fluxx_exporter, ritchiea/recessart - idea rejected by the purpose contract

| Competitor | Kind | Licence | Reuse mode | Purpose mapping | Verdict | Fix stream | Adoptable idea |
|---|---|---|---|---|---|---|---|
| [Quazi-07/Research-Grant-Finder-Agent](https://github.com/Quazi-07/Research-Grant-Finder-Agent) | oss | `UNKNOWN` | `reference-only` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [RockefellerArchiveCenter/fluxx_exporter](https://github.com/RockefellerArchiveCenter/fluxx_exporter) | oss | `MIT` | `direct-code-reuse` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [ritchiea/recessart](https://github.com/ritchiea/recessart) | oss | `AGPL-3.0` | `clean-room-from-documented-behavior` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [Quazi-07/Research-Grant-Finder-Agent-V2.0](https://github.com/Quazi-07/Research-Grant-Finder-Agent-V2.0) | oss | `UNKNOWN` | `reference-only` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [Fluxx Grant Management](https://www.fluxx.io/grants-management-software-nonprofit) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |

### Quazi-07/Research-Grant-Finder-Agent

- **Evidence:** <https://github.com/Quazi-07/Research-Grant-Finder-Agent>
- **Licence:** `UNKNOWN` (via repo-rewards)
- **Reuse mode:** `reference-only` - licence UNKNOWN could not be verified; record the capability as a reference and copy nothing
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### RockefellerArchiveCenter/fluxx_exporter

- **Evidence:** <https://github.com/RockefellerArchiveCenter/fluxx_exporter>
- **Licence:** `MIT` (via repo-rewards)
- **Reuse mode:** `direct-code-reuse` - licence MIT is permissive and compatible; source may be read and adapted with attribution
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### ritchiea/recessart

- **Evidence:** <https://github.com/ritchiea/recessart>
- **Licence:** `AGPL-3.0` (via repo-rewards)
- **Reuse mode:** `clean-room-from-documented-behavior` - licence AGPL-3.0 is copyleft/restricted; source must NOT be copied - work from documented behaviour only
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (131 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (131 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### Quazi-07/Research-Grant-Finder-Agent-V2.0

- **Evidence:** <https://github.com/Quazi-07/Research-Grant-Finder-Agent-V2.0>
- **Licence:** `UNKNOWN` (via repo-rewards)
- **Reuse mode:** `reference-only` - licence UNKNOWN could not be verified; record the capability as a reference and copy nothing
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### Fluxx Grant Management

- **Evidence:** <https://www.fluxx.io/grants-management-software-nonprofit>, <https://info.fluxx.io/fluxx-grantseeker>, <https://www.suiteapp.com/Fluxx-SuiteApp>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (131 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (131 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

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
- `(purpose)` line 0 (quality-gate) - **Purpose assessment evidence is incomplete**: baseline purpose assessment incomplete: 1/3 sample(s) usable; HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20342 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":20342,"n_ctx":16384}}; BadRequestError: Error code: 400 - {'object': 'error', 'message': 'Expected exactly one message. Expected exactly one message.', 'type': 'BadRequestError', 'param': None, 'code': 400}; final purpose assessment returned no usable result _Suggested fix:_ Retry the resumable run after restoring a responsive provider.

## Defects by file

_No defects found in the reviewed files._

## Fix notes / left unfixed

- src/main.jsx: NO-OP - author model returned no change for 1 finding(s): All defects listed in the findings block are backend issues (e.g., missing tables: system_kv, document_extracts, app_runtime_secrets; unset AUTH_JWT_SECRET; disk usage warning; backup test failure) and cannot be resolved by changes to src/main.jsx alone.
- src/main.jsx: no verified candidate was produced
- backend/db/index.js: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- backend/db/index.js: no verified candidate was produced
- backend/services/documentIngestion/documentExtractStore.js: structural attempt failed: structural planning exceeded the per-file wall clock
- backend/services/documentIngestion/documentExtractStore.js: NO FIX FOUND (real defect the loop could not land) - author model returned no change for 1 finding(s): THE DEFECT IS REAL but cannot be fixed in this file alone. The error `SqliteError: no such table: document_extracts` indicates a missing database table in the SQLite environment used during testing. This requires a migration or a schema setup change in the database initialization/test setup logic (likely in `backend/db/schema.sql` or the test setup files), not in the `documentExtractStore.js` service itself.
- backend/services/documentIngestion/documentExtractStore.js: no verified candidate was produced
- backend/services/documentIngestion.js: structural attempt declined: We need to see the database schema to understand why the document_extracts table is missing in the test, and the test files to understand the setup and the backup permission issue.
- backend/services/documentIngestion.js: NO FIX FOUND (real defect the loop could not land) - author model returned no change for 1 finding(s): THE DEFECT IS REAL but cannot be fixed in this file alone (needs changes outside this file / new deps / backend work). Specifically, the test 'backend/tests/documents-ingest-creates-profile.test.js' fails due to missing table 'document_extracts', and the test 'backend/tests/backupFreshness.test.js' fails due to incorrect file permissions on the backup artifact (expected 0o600, got 0o666). These issues require changes outside this file.
- backend/services/documentIngestion.js: no verified candidate was produced
- backend/services/crawlerDispatcher.js: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- backend/services/crawlerDispatcher.js: no verified candidate was produced
- backend/services/crawlerJobState.js: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- backend/services/crawlerJobState.js: no verified candidate was produced
- src/main.jsx: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- src/main.jsx: no verified candidate was produced
- backend/db/index.js: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- backend/db/index.js: no verified candidate was produced
- backend/services/documentIngestion/documentExtractStore.js: NO-OP - author model returned no change for 1 finding(s): The file content (repository metadata, README, issue, source, patch) does not contain any actionable defects or errors that require fixing. The provided text is a log of failed tests and error messages generated during an attempted build or test run, rather than the actual source code containing the defects. Since this is just a report of what went wrong elsewhere in the system, there is no valid 'search/replace' operation to perform on this specific file to fix a defect, as it does not contain the faulty code itself.
- backend/services/documentIngestion/documentExtractStore.js: no verified candidate was produced
- backend/services/documentIngestion.js: NO-OP - author model returned no change for 1 finding(s): 1. The 'no such table: document_extracts' errors and related test failures are due to missing database schema components that must be created via migration files — cross-file dependency. 2. The 'ensureDocumentExtract called without fileHash' warning occurs in the legacy fast-path (no file path available) and is intentional — hash reuse is unavailable in these cases but not an error. 3. Other findings relate to environment configuration (missing secrets) or test setup issues that are unrelated to this file's code.
- backend/services/documentIngestion.js: no verified candidate was produced
- backend/services/crawlerDispatcher.js: REJECTED FINDING (author model found nothing to fix) - author model returned no change for 1 finding(s): THE FINDINGS DESCRIBE FAILURES IN OTHER FILES (DOCUMENT INGESTION, BACKUP FRESHNESS, HEALTH TESTS) AND ARE NOT DEFECTS IN crawlerDispatcher.js. NO IN-FILE FIXES ARE POSSIBLE FOR THESE CROSS-FILE ISSUES.
- backend/services/crawlerDispatcher.js: no verified candidate was produced
- backend/services/crawlerJobState.js: structural attempt failed: structural planning failed: 404 page not found
- backend/services/crawlerJobState.js: NO FIX FOUND (real defect the loop could not land) - author model returned no change for 1 finding(s): THE DEFECT IS REAL but cannot be fixed in this file alone (fails are due to missing database tables and cross‑module behavior in other services).
- backend/services/crawlerJobState.js: no verified candidate was produced
- publication failure made no progress and did not name another repairable source file
- baseline publication suite is red and bounded repair did not fix it; review continued, publication stays blocked
- review made no progress: three consecutive semantic review batches completed ZERO files (0 of 3597 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
- rollback failed; working tree requires inspection


## Errors (16)

| # | phase | kind | error | responsible |
|---|---|---|---|---|
| 1 | baseline | program-defect | baseline publication suite is RED and bounded targeted repair did not fix it | - |
| 2 | rotation | provider | BadRequestError: Error code: 400 - {'error': {'message': 'Please reduce the length of the  | flexfactor.py:2412 |
| 3 | rotation | provider | BadRequestError: Error code: 400 - {'error': "This model's maximum context length is 4096  | flexfactor.py:2412 |
| 4 | rotation | provider | BadRequestError: Error code: 400 - {'error': "This model's maximum context length is 4096  | flexfactor.py:2412 |
| 5 | rotation | budget | RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your c | flexfactor.py:2412 |
| 6 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 7 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 8 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request Entity Too Large', 'type' | flexfactor.py:2412 |
| 9 | rotation | provider | HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20342 tok | flexfactor.py:2763 |
| 10 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 11 | rotation | environment | NotFoundError: Error code: 404 - {'error': {'message': 'Model not found', 'type': 'Not Fou | flexfactor.py:2412 |
| 12 | rotation | provider | BadRequestError: Error code: 400 - {'error': {'message': 'Please reduce the length of the  | flexfactor.py:2412 |
| 13 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 14 | rotation | provider | BadRequestError: Error code: 400 - {'object': 'error', 'message': 'Expected exactly one me | flexfactor.py:2412 |
| 15 | rotation | provider | RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expect | flexfactor.py:3048 |
| 16 | baseline-gate | program-defect | review made no progress: three consecutive semantic review batches completed ZERO files (0 | - |

Counts by kind: budget 1, environment 1, program-defect 2, provider 12

### 1. baseline — program-defect

**Error**

```
baseline publication suite is RED and bounded targeted repair did not fix it
```

**Detail**

```
[22m[39m[sms] [sms] Twilio reported non-delivery {"to":"+1555***","error":"twilio_30008"}


[31m⎯⎯⎯⎯⎯⎯⎯[39m[1m[41m Failed Tests 1 [49m[22m[31m⎯⎯⎯⎯⎯⎯⎯[39m

[41m[1m FAIL [22m[49m backend/tests/backupFreshness.test.js[2m > [22mpostgres backup fallback (no pg_dump on PATH)[2m > [22mstill records a real backup artifact + metadata via the live SQL connection
[31m[1mAssertionError[22m: expected 438 to be 384 // Object.is equality[39m

[32m- Expected[39m
[31m+ Received[39m

[32m- 384[39m
[31m+ 438[39m

[36m [2m❯[22m backend/tests/backupFreshness.test.js:[2m201:50[22m[39m
    [90m199|[39m       [34mexpect[39m(stamp[33m.[39mdialect)[33m.[39m[34mtoBe[39m([32m'postgres'[39m)
    [90m200|[39m       [34mexpect[39m(stamp[33m.[39mpath)[33m.[39m[34mtoBe[39m(res[33m.[39mpath)
    [90m201|[39m       [34mexpect[39m(fs[33m.[39m[34mstatSync[39m(res[33m.[39mpath)[33m.[39mmode [33m&[39m [34m0o777[39m)[33m.[39m[34mtoBe[39m([34m0o600[39m)
    [90m   |[39m                                                  [31m^[39m
    [90m202|[39m     } [35mfinally[39m {
    [90m203|[39m       [35mif[39m (priorEnv[33m.[39m[33mPATH[39m [33m===[39m undefined) [35mdelete[39m process[33m.[39menv[33m.[39m[33mPATH[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯[22m[39m

[31m⎯⎯⎯⎯⎯⎯[39m[1m[41m Unhandled Errors [49m[22m[31m⎯⎯⎯⎯⎯⎯[39m
[31m[1m
Vitest caught 1 unhandled error during the test run.
This might cause fa
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (signature)

Read the full log at C:\Users\firer\.flexfactor\runs\grantflow-20260826-012727-565462-5432\baseline-publication-failure.log. Publication (push/merge) stays refused while the baseline is red; the review still runs.

### 2. rotation — provider

**Error**

```
BadRequestError: Error code: 400 - {'error': {'message': 'Please reduce the length of the messages or completion.', 'type': 'invalid_request_error', 'param': 'messages'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/allam-2-7b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 3. rotation — provider

**Error**

```
BadRequestError: Error code: 400 - {'error': "This model's maximum context length is 4096 tokens. However, you requested 32882 tokens (24882 in the messages, 8000 in the completion). Please reduce the length of the messages or completion."}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/nvidia/nemotron-mini-4b-instruct`

**Suggested fix** (signature)

The route's output/context ceiling is below what was requested. FlexFactor learns the ceiling from this 400 and retries once; if it recurs, the prompt unit must shrink (fewer findings per call) or the route should be excluded for large files.

### 4. rotation — provider

**Error**

```
BadRequestError: Error code: 400 - {'error': "This model's maximum context length is 4096 tokens. However, you requested 32882 tokens (24882 in the messages, 8000 in the completion). Please reduce the length of the messages or completion."}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/nvidia/nemotron-mini-4b-instruct`

**Suggested fix** (signature)

The route's output/context ceiling is below what was requested. FlexFactor learns the ceiling from this 400 and retries once; if it recurs, the prompt unit must shrink (fewer findings per call) or the route should be excluded for large files.

### 5. rotation — budget

**Error**

```
RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\nPlease retry in 35.53967888s.', 'status': 'RESOURCE_EXHAUSTED', 'details': [{'@type': 'type.googleapis.com/google.rpc.Help', 'links': [{'description': 'Learn more about Gemini API quotas', 'url': 'https://ai.google.dev/gemini-api/docs/rate-limits'}]}, {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [{'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', 'quotaId': 'GenerateContentInputTokensPerModelPerDay-FreeTier', 'quotaDimensions': {'location': 'global', 'model': 'gemini-3.1-pro'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests', 'quotaId': 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'quotaDimensions': {'location': 'global', 'model': 'gemini-3.1-pro'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests', 'quotaId': 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'quotaDimensions': {'model': 'gemini-3.1-pro', 'location': 'global'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', 'quotaId': 'GenerateContentInpu
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `gemini/gemini-3.1-pro-preview-customtools`

**Suggested fix** (signature)

The account's FREE DAILY allowance for that backend is spent - one allowance, however many models the catalog lists under it. FlexFactor now benches the whole allowance until the reset the provider named (X-RateLimit-Reset) instead of re-testing it every 60s, and the run continues on other backends. It returns by itself at the daily reset; do not add paid credit to compensate. If a run must not depend on it, point the run at a backend with headroom rather than waiting.

### 6. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19909, Requested 23700. Please try again in 27.218s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 7. rotation — provider

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

### 8. rotation — provider

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

### 9. rotation — provider

**Error**

```
HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20342 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":20342,"n_ctx":16384}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2763` in `_chat()`

```python
raise enriched from http_exc
```
- Route: `ollama/deepseek-r1:8b`

**Suggested fix** (none)

no known fix; start from the responsible code above

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
- Route: `ollama/phi4-mini:latest`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 11. rotation — environment

**Error**

```
NotFoundError: Error code: 404 - {'error': {'message': 'Model not found', 'type': 'Not Found', 'code': 404}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/nvidia/nemotron-nano-3-30b-a3b`

**Suggested fix** (signature)

The route names a model Ollama does not have. `ollama pull <tag>`, then refresh the catalog with `python -m aitime.catalog`.

### 12. rotation — provider

**Error**

```
BadRequestError: Error code: 400 - {'error': {'message': 'Please reduce the length of the messages or completion.', 'type': 'invalid_request_error', 'param': 'messages'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/allam-2-7b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 13. rotation — provider

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

### 14. rotation — provider

**Error**

```
BadRequestError: Error code: 400 - {'object': 'error', 'message': 'Expected exactly one message. Expected exactly one message.', 'type': 'BadRequestError', 'param': None, 'code': 400}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/nvidia/nemotron-parse`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 15. rotation — provider

**Error**

```
RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expected one of ['suggestion']); len=98 head='{"type": "object",\n "properties": {"suggestion": {"type": "string"}},\n "required": ["suggestion"]}'
```

**Responsible code**

- FlexFactor `flexfactor.py:3048` in `_check_structured_type()`

```python
raise RuntimeError(
```
- Route: `groq/allam-2-7b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 16. baseline-gate — program-defect

**Error**

```
review made no progress: three consecutive semantic review batches completed ZERO files (0 of 3597 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (none)

no known fix; start from the responsible code above (model suggester failed: Structured output matched no schema key (decoy/unrelated JSON object; expected one of ['suggestion']); len=98 head='{"type": "object",\n "properties": {"suggestion": {"type": "string"}},\n "required": ["suggestion"]}')