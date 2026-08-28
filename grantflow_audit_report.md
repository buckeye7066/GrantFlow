# FlexFactor audit — GrantFLow

- **Project:** `C:\Users\firer\GrantFlow`
- **Branch:** `main`
- **Toolchains:** java, node, swift
- **Build verification:** NOT AVAILABLE — dependencies not installed for swift:ios/App/CapApp-SPM - build gate would false-fail. Fixes in this run were NOT build-verified.
- **Dependency bootstrap:** 1/2 install step(s) succeeded — a failed install can make the build gate red for reasons unrelated to the code
- **Files reviewed:** 1 of 3595 candidate(s)
- **FILE ACCOUNTING: 3595 candidate(s) = 1 reviewed + 3561 never_attempted + 31 review_incomplete + 2 skipped_known_clean**
- **MOSTLY SKIPPED: only 1 of 3595 candidate file(s) (0%) were reviewed.**
- **Defects found:** 9
- **Files fixed:** 1
- **No-ops:** 1 (none are successes) — **0 rejected finding(s)** (author found nothing to fix — a REVIEW-precision defect, not a fix failure), **1 no fix found** (a real defect the loop could not land)
- **Errors recorded:** 97 (see the Errors section below; ledger at `C:\Users\firer\.flexfactor\runs\grantflow-20260826-173358-556165-36728\errors.md`)
- **Baseline build:** passed
- **Unit tests added:** 0 (suite not run)
- **Button/UI (Playwright):** skipped
- **Cycles run:** 1
- **Providers:** rotation:nvidia/nemotron-3.5-lightning:free
- **Git:** PROVIDER-OUTAGE ABORT on main: checkpoint preserved; no unverified commit created

## System inventory

**171590 entries accounted for.**

| Category | Count |
|---|---:|
| artifact-subtree | 50 |
| binary-asset | 1869 |
| configuration-documentation-or-data | 18346 |
| first-party-source | 151314 |
| reparse-directory | 11 |

The immutable run manifest contains the complete path-level inventory. Artifact, binary, and reparse entries are named and classified; they are not represented as line-reviewed source.

## Executable evidence

- **Evidence run:** `grantflow-20260826-173358-556165-36728`
- **Exact final commit:** `1d1399af64e759eec2f342357249f49f1e0a865d`
- **Code map:** 4205 file(s), 18879 function(s), 1261 route(s), 3832 material control(s)
- **Function execution:** 0/16243 with invocation evidence
- **Route execution:** 0/1261
- **Control execution:** 0/3832
- **Changed-file rescan:** 2/2 (complete)
- **Blast radius:** 7 affected file(s); analysis ran
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
  - `idea:GrantStation` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for GrantStation
  - `web:searxng` - RuntimeError: FLEXFACTOR_SEARXNG_URL is not set

- **Ideas accepted as serving this program's purpose:** 4 (rejected 1 - the purpose contract, not the competitor, decides)

- **Bridged into the fix stream:** 0 of 5 candidate(s)
  - NOT bridged (3): CiviCRM, Instrumentl, OpenGrantStack/GrantReady-hub-SaaS - accepted idea did not map to a valid acceptance criterion
  - NOT bridged (1): GrantStation - idea rejected by the purpose contract
  - NOT bridged (1): grantflow-ai/grantflow - not bridgeable (evidence=verified, reuse_mode=reference-only)

| Competitor | Kind | Licence | Reuse mode | Purpose mapping | Verdict | Fix stream | Adoptable idea |
|---|---|---|---|---|---|---|---|
| [CiviCRM](https://github.com/civicrm/civicrm-core) | oss | `AGPL-3.0` | `clean-room-from-documented-behavior` | acceptance #Acceptance criteria 6 and 8 from the program's purpose contract require portal handoffs and authenticated journeys respectively, which are not currently implemented in GrantFLow according to the provided code files and evidence basis. This idea serves the audited program's own stated job by closing a gap between current state and authored purpose as requested in the directive work theme. | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Authenticated end-to-end journey with portal handoffs and 2FA/signature handling |
| [grantflow-ai/grantflow](https://github.com/grantflow-ai/grantflow) | oss | `NOASSERTION` | `reference-only` | purpose-only | ACCEPT | NOT entered - not bridgeable (evidence=verified, reuse_mode=reference-only) | AI-driven grant application drafting |
| [OpenGrantStack/GrantReady-hub-SaaS](https://github.com/OpenGrantStack/GrantReady-hub-SaaS) | oss | `Apache-2.0` | `direct-code-reuse` | acceptance #6. Hamilton and other portal handoffs | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Role-Based Approval Workflow |
| [Instrumentl](https://www.instrumentl.com/solutions/nonprofits) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | acceptance #Acceptance Criteria #6 (Hamilton and other portal handoffs) and #8 (authenticated end-to-end journey) are both directly advanced by implementing this idea. | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Authenticated end-to-end journey with portal handoffs |
| [GrantStation](https://grantstation.com/) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |

### CiviCRM

- **Evidence:** <https://github.com/civicrm/civicrm-core>, <https://github.com/civicrm/civicrm-wordpress>
- **Licence:** `AGPL-3.0` (via github-api)
- **Reuse mode:** `clean-room-from-documented-behavior` - licence AGPL-3.0 is copyleft/restricted; source must NOT be copied - work from documented behaviour only
- **Idea:** Authenticated end-to-end journey with portal handoffs and 2FA/signature handling - CiviCRM supports authenticated user journeys through portals with 2FA and signature handling, ensuring secure transitions between systems.
- **Value here:** GrantFLow's purpose contract explicitly requires 'handles portals/2FA/signatures honestly' and 'authenticated end-to-end journey', but current implementation lacks these features.
- **Purpose / criterion mapping:** acceptance #Acceptance criteria 6 and 8 from the program's purpose contract require portal handoffs and authenticated journeys respectively, which are not currently implemented in GrantFLow according to the provided code files and evidence basis. This idea serves the audited program's own stated job by closing a gap between current state and authored purpose as requested in the directive work theme. - This feature directly addresses acceptance criteria 6 (Hamilton and other portal handoffs) and 8 (authenticated end-to-end journey), which are explicitly required by the purpose contract. Adding this would advance the program toward fulfilling its authored purpose rather than making it more like a generic competitor without advancing its own goals.
- **Purpose verdict:** ACCEPTED - This feature directly addresses acceptance criteria 6 (Hamilton and other portal handoffs) and 8 (authenticated end-to-end journey), which are explicitly required by the purpose contract. Adding this would advance the program toward fulfilling its authored purpose rather than making it more like a generic competitor without advancing its own goals.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** CiviCRM core documentation shows integration with portal authentication flows, including 2FA support and signature handling for secure transitions. This capability is not present in GrantFLow's codebase as evidenced by lack of relevant components or modules in the provided files. (confidence high)

### grantflow-ai/grantflow

- **Evidence:** <https://github.com/grantflow-ai/grantflow>
- **Licence:** `NOASSERTION` (via repo-rewards)
- **Reuse mode:** `reference-only` - licence NOASSERTION could not be verified; record the capability as a reference and copy nothing
- **Idea:** AI-driven grant application drafting - Uses ML/AI to automatically generate draft grant application sections based on user profile and opportunity data.
- **Value here:** Would enable faster, profile‑specific application creation, closing a gap in the current AI assistance which only summarizes and recommends.
- **Purpose / criterion mapping:** purpose-only - Accelerates the application workflow while preserving provenance and fit explanations, supporting the whole‑profile funding discovery and application workflow purpose.
- **Purpose verdict:** ACCEPTED - Accelerates the application workflow while preserving provenance and fit explanations, supporting the whole‑profile funding discovery and application workflow purpose.
- **Fix-stream decision:** DID NOT enter the fix stream - not bridgeable (evidence=verified, reuse_mode=reference-only)
- **Evidence basis:** Competitor description: 'GrantFlow.ai is a platform for creating grant applications using ML and AI'. (confidence low)

### OpenGrantStack/GrantReady-hub-SaaS

- **Evidence:** <https://github.com/OpenGrantStack/GrantReady-hub-SaaS>
- **Licence:** `Apache-2.0` (via repo-rewards)
- **Reuse mode:** `direct-code-reuse` - licence Apache-2.0 is permissive and compatible; source may be read and adapted with attribution
- **Idea:** Role-Based Approval Workflow - Enables configurable multi-step approval processes for grant applications with status tracking, notifications, and immutable audit logs.
- **Value here:** Adds governance and traceability to the application workflow, ensuring proper handling of signatures and reducing errors, which supports GrantFlow’s goal of honest portal handling and proven outcomes.
- **Purpose / criterion mapping:** acceptance #6. Hamilton and other portal handoffs - Adopting approval workflow strengthens honest handling of portals/signatures and provides auditable outcomes, directly advancing the program’s purpose.
- **Purpose verdict:** ACCEPTED - Adopting approval workflow strengthens honest handling of portals/signatures and provides auditable outcomes, directly advancing the program’s purpose.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** Competitor description highlights secure collaboration and approval workflows as core features. (confidence medium)

### Instrumentl

- **Evidence:** <https://www.instrumentl.com/solutions/nonprofits>, <https://moge.ai/product/instrumentl>, <https://help.instrumentl.com/en/articles/14794007-discover-plan>, <https://github.com/lilic/instrumently>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** Authenticated end-to-end journey with portal handoffs - Instrumentl provides a seamless, authenticated workflow that connects users from initial profile setup through to grant application submission, including secure portal logins and 2FA handling.
- **Value here:** This directly addresses acceptance criteria #6 (Hamilton and other portal handoffs) and #8 (authenticated end-to-end journey), which are critical for ensuring trust, compliance, and accurate provenance in funding discovery.
- **Purpose / criterion mapping:** acceptance #Acceptance Criteria #6 (Hamilton and other portal handoffs) and #8 (authenticated end-to-end journey) are both directly advanced by implementing this idea. - Adopting this idea directly serves the stated purpose by closing the gap in GrantFlow’s current capability to handle authenticated journeys and portal handoffs — a core requirement for trustworthiness and compliance in funding workflows. This addresses the red required publication suite issue of missing portal integration functionality, which is part of the core workflow described in the purpose contract.
- **Purpose verdict:** ACCEPTED - Adopting this idea directly serves the stated purpose by closing the gap in GrantFlow’s current capability to handle authenticated journeys and portal handoffs — a core requirement for trustworthiness and compliance in funding workflows. This addresses the red required publication suite issue of missing portal integration functionality, which is part of the core workflow described in the purpose contract.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** From publicly documented behavior of Instrumentl's nonprofit grant management platform, it is known that their system supports authenticated user flows with portal integrations and secure credential handling, though specific implementation details are not available. (confidence high)

### GrantStation

- **Evidence:** <https://grantstation.com/>, <https://grantstation.com/public-resources/pathfinder/grant-hub>, <https://grantprofessionals.org/news/712761/More-than-a-Database-Unlocking-the-Many-Benefits-of-GrantStation.htm>, <https://github.com/jderrod/GrantStationTool>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Expecting value: line 1 column 1 (char 0)
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
- `(purpose)` line 0 (quality-gate) - **Purpose assessment evidence is incomplete**: baseline purpose assessment incomplete: 1/3 sample(s) usable; BadRequestError: Error code: 400 - {'error': {'message': 'Provider returned error', 'code': 400, 'metadata': {'raw': '{"code":400,"msg":"bad request","request_id":"2f6d8151-8985-4ad1-b563-52d0c22490b7"}', 'provider_name': 'AtlasCloud', 'is_byok': False}}, 'user_id': 'user_3GWU0JMa1TcZebCavX9qtXxTXSU'}; TypeError: 'NoneType' object is not subscriptable; final purpose assessment returned no usable result _Suggested fix:_ Retry the resumable run after restoring a responsive provider.

### medium (1)
- `src/api/foundations.js` line 11 (error-handling) - **Missing error handling**: The API call does not return an error when the request fails or the server returns an error _Suggested fix:_ Wrap the API call in a try-catch block to handle errors

### low (1)
- `src/api/foundations.js` line 86 (edge-case) - **Potential null value**: The function assumes that the 'month' parameter is always provided _Suggested fix:_ Add a check to handle the case where 'month' is undefined or null

## Defects by file

### `src/api/foundations.js` ⚠️ changed; resolution unverified
- **[medium]** line 11 (error-handling) — **Missing error handling**: The API call does not return an error when the request fails or the server returns an error _Fix:_ Wrap the API call in a try-catch block to handle errors
- **[low]** line 86 (edge-case) — **Potential null value**: The function assumes that the 'month' parameter is always provided _Fix:_ Add a check to handle the case where 'month' is undefined or null

## Fix notes / left unfixed

- src/main.jsx: structural attempt failed: structural planning exceeded the per-file wall clock
- src/main.jsx: NO FIX FOUND (real defect the loop could not land) - author model returned no change for 1 finding(s): THE DEFECT IS REAL but cannot be fixed in this file alone. The findings describe backend test failures (in itemFundingCrawlerSearch, yanaHtmlFetcherSsrf, braveRateLimit, samDailyCodeSweep, samSchedulerAutofix, smsSendHonesty, backupFreshness) and Vitest worker timeouts for test files UniversityApplicationsSection.test.jsx and HamiltonTaskDrawer.test.jsx. These defects require changes in backend code or test configuration, not in src/main.jsx.
- src/main.jsx: no verified candidate was produced
- src/main.jsx: structural attempt failed: structural planning failed: Expecting value: line 1 column 1 (char 0)
- src/main.jsx: NO FIX FOUND (real defect the loop could not land) - author model returned no change for 1 finding(s): THE DEFECT IS REAL but cannot be fixed in this file alone (needs changes outside this file / new deps / backend work). The findings describe backend test failures (backupFreshness.test.js) and Vitest worker timeouts for two frontend test files (UniversityApplicationsSection.test.jsx and HamiltonTaskDrawer.test.jsx). No changes in src/main.jsx can fix these defects because they are either backend-related or related to the test setup/test files themselves, which are outside the scope of this file.
- src/main.jsx: no verified candidate was produced
- publication failure made no progress and did not name another repairable source file
- baseline publication suite is red and bounded repair did not fix it; review continued, publication stays blocked
- scripts/anya-autonomous.mjs: structural attempt failed: structural planning exceeded the per-file wall clock
- scripts/anya-autonomous.mjs: NO FIX FOUND (real defect the loop could not land) - author model returned no change for 1 finding(s): THE DEFECT IS REAL but cannot be fixed in this file alone (needs changes outside this file / new deps / backend work). The defect is about adding retry and state-persistence logic to the Amy autonomous crawler (which is in backend/services/anyaAutonomousCrawler.js), but we are only given the CLI harness (scripts/anya-autonomous.mjs).
- review made no progress: three consecutive semantic review batches completed ZERO files (1 of 3595 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
- rollback failed; working tree requires inspection


## Errors (97)

| # | phase | kind | error | responsible |
|---|---|---|---|---|
| 1 | rotation | budget | APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. V | flexfactor.py:2412 |
| 2 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 3 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 4 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 5 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 6 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 7 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 8 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 9 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 10 | rotation | provider | InternalServerError: Error code: 503 - [{'error': {'code': 503, 'message': 'This model is  | flexfactor.py:2412 |
| 11 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 12 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 13 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 14 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 15 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 16 | rotation | provider | InternalServerError: Error code: 503 - [{'error': {'code': 503, 'message': 'This model is  | flexfactor.py:2412 |
| 17 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 18 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 19 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 20 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 21 | rotation | provider | InternalServerError: Error code: 503 - [{'error': {'code': 503, 'message': 'This model is  | flexfactor.py:2412 |
| 22 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 23 | rotation | provider | NotFoundError: 404 page not found | flexfactor.py:2412 |
| 24 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 25 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 26 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 27 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 28 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 29 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 30 | rotation | provider | BadRequestError: Error code: 400 - {'error': {'message': "request: Value error, 'response_ | flexfactor.py:2412 |
| 31 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 32 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 33 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 34 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 35 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 36 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 37 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 38 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 39 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 40 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 41 | rotation | provider | APITimeoutError: Request timed out. | flexfactor.py:2412 |
| 42 | baseline | program-defect | baseline publication suite is RED and bounded targeted repair did not fix it | - |
| 43 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 44 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 45 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 46 | rotation | provider | BadRequestError: Error code: 400 - {'error': {'message': 'Provider returned error', 'code' | flexfactor.py:2412 |
| 47 | rotation | provider | TypeError: 'NoneType' object is not subscriptable | flexfactor.py:2552 |
| 48 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 49 | rotation | budget | APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. V | flexfactor.py:2412 |
| 50 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 51 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 52 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 53 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 54 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 55 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 56 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 57 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 58 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 59 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 60 | rotation | provider | PermissionDeniedError: Error code: 403 - {'error': {'message': 'thinkingmachines/inkling:f | flexfactor.py:2412 |
| 61 | rotation | provider | PermissionDeniedError: Error code: 403 - {'error': {'message': 'thinkingmachines/inkling-s | flexfactor.py:2412 |
| 62 | rotation | provider | TypeError: 'NoneType' object is not subscriptable | flexfactor.py:2552 |
| 63 | fix | program-defect | Expecting value: line 1 column 1 (char 0) | src/api/foundations.js |
| 64 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 65 | rotation | provider | APITimeoutError: Request timed out. | flexfactor.py:2412 |
| 66 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 67 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 68 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 69 | rotation | provider | RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your c | flexfactor.py:2412 |
| 70 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 71 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 72 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 73 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 74 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 75 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 76 | rotation | flexfactor-defect | OutputBudgetError: Model output hit the 16384-token budget (file too large to regenerate i | flexfactor.py:2559 |
| 77 | rotation | provider | APITimeoutError: Request timed out. | flexfactor.py:2412 |
| 78 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 79 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 80 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 81 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 82 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 83 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 84 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 85 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 86 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 87 | rotation | provider | RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expect | flexfactor.py:3048 |
| 88 | rotation | budget | APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. V | flexfactor.py:2412 |
| 89 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 90 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 91 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 92 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 93 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 94 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 95 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': | flexfactor.py:2412 |
| 96 | rotation | provider | TypeError: 'NoneType' object is not subscriptable | flexfactor.py:2552 |
| 97 | baseline-gate | program-defect | review made no progress: three consecutive semantic review batches completed ZERO files (1 | - |

Counts by kind: budget 3, flexfactor-defect 1, program-defect 3, provider 90

### 1. rotation — budget

**Error**

```
APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. Visit your billing tab.', 'type': 'payment_required_error', 'param': 'quota', 'code': 'payment_required'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `cerebras/gpt-oss-120b`

**Suggested fix** (signature)

The provider's allowance for this key is spent (OpenRouter's free tier is balance-bound). The rotator cools that pool and moves on; it recovers when the allowance resets. Do not add paid credit to compensate.

### 2. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.6-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 17980, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/qwen/qwen3.6-27b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 3. rotation — provider

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

### 4. rotation — provider

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

### 5. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-26b-a4b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 6. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '00bdd0a7-e38f-4423-9007-c4d8730a3f78': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/writer/palmyra-creative-122b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 7. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.8-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 25125, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/qwen/qwen3.8-27b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 8. rotation — provider

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

### 9. rotation — provider

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

### 10. rotation — provider

**Error**

```
InternalServerError: Error code: 503 - [{'error': {'code': 503, 'message': 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', 'status': 'UNAVAILABLE'}}]
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `gemini/gemma-4-31b-it`

**Suggested fix** (signature)

Provider overloaded. Rotation already moves to the next pool; no change needed.

### 11. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '316490c6-f1ed-41f9-9da8-3fa9e885653b': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/writer/palmyra-fin-70b-32k`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 12. rotation — provider

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

### 13. rotation — provider

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

### 14. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-safeguard-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12878, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-safeguard-20b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 15. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'aab71274-5281-4941-b0b8-20f339d1fc7e': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/writer/palmyra-med-70b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 16. rotation — provider

**Error**

```
InternalServerError: Error code: 503 - [{'error': {'code': 503, 'message': 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', 'status': 'UNAVAILABLE'}}]
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `gemini/gemma-4-26b-a4b-it`

**Suggested fix** (signature)

Provider overloaded. Rotation already moves to the next pool; no change needed.

### 17. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'd6faa974-3591-49a4-963d-97221d074b2e': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/writer/palmyra-med-70b-32k`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 18. rotation — provider

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

### 19. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 30778, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-20b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 20. rotation — provider

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

### 21. rotation — provider

**Error**

```
InternalServerError: Error code: 503 - [{'error': {'code': 503, 'message': 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', 'status': 'UNAVAILABLE'}}]
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `gemini/gemma-4-31b-it`

**Suggested fix** (signature)

Provider overloaded. Rotation already moves to the next pool; no change needed.

### 22. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/mirage335/Qwen3-Coder-30b-virtuoso:latest`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 23. rotation — provider

**Error**

```
NotFoundError: 404 page not found
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/bigcode/starcoder2-15b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 24. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/qwen3-coder:30b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 25. rotation — provider

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

### 26. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-120b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 19350, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-120b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 27. rotation — provider

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

### 28. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-26b-a4b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 29. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/qwen3.6:35b-a3b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 30. rotation — provider

**Error**

```
BadRequestError: Error code: 400 - {'error': {'message': "request: Value error, 'response_format' with type 'json_object' requires a JSON schema. Use 'response_format' with type 'json_schema' and provide a schema, or use 'guided_json' directly with a JSON schema. See: https://docs.vllm.ai/en/latest/features/structured_outputs.html", 'type': 'BadRequestError', 'code': 400}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/google/diffusiongemma-26b-a4b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 31. rotation — provider

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

### 32. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.6-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 21267, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/qwen/qwen3.6-27b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 33. rotation — provider

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

### 34. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-31b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 35. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/mirage335/Qwen3-Coder-30b-virtuoso:latest`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 36. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/qwen3-coder:30b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 37. rotation — provider

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

### 38. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.8-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 25123, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/qwen/qwen3.8-27b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 39. rotation — provider

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

### 40. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-26b-a4b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 41. rotation — provider

**Error**

```
APITimeoutError: Request timed out.
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/google/gemma-4-31b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 42. baseline — program-defect

**Error**

```
baseline publication suite is RED and bounded targeted repair did not fix it
```

**Detail**

```

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
Vitest caught 6 unhandled errors during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.[22m[39m

[31m⎯⎯⎯⎯[39m[1m[41m Unhandled Rejection [49m[22m[31m⎯⎯⎯⎯⎯[39m
[31m[1mEnvironmentTeardownError[22m: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending[39m
[31mThis error originated in "[1mbackend/tests/adminReinterviewGate.test.js[22m" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.[39m

[31m⎯⎯⎯⎯[39m[1m[41m Unhandled Rejection [49m[22m[31m⎯⎯
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (signature)

Read the full log at C:\Users\firer\.flexfactor\runs\grantflow-20260826-173358-556165-36728\baseline-publication-failure.log. Publication (push/merge) stays refused while the baseline is red; the review still runs.

### 43. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': 429, 'metadata': {'raw': 'liquid/lfm-2.5-2.6b:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations', 'provider_name': 'Liquid', 'is_byok': False, 'provider_error_code': 'rate_limit_exceeded', 'limit_source': 'upstream_provider_shared_pool', 'remedy_hint': 'Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing', 'retry_after_seconds': 39, 'retry_after_seconds_raw': 39, 'headers': {'Retry-After': '39'}}}, 'user_id': 'user_3GWU0JMa1TcZebCavX9qtXxTXSU'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/liquid/lfm-2.5-2.6b:free`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 44. rotation — provider

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

### 45. rotation — provider

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

### 46. rotation — provider

**Error**

```
BadRequestError: Error code: 400 - {'error': {'message': 'Provider returned error', 'code': 400, 'metadata': {'raw': '{"code":400,"msg":"bad request","request_id":"2f6d8151-8985-4ad1-b563-52d0c22490b7"}', 'provider_name': 'AtlasCloud', 'is_byok': False}}, 'user_id': 'user_3GWU0JMa1TcZebCavX9qtXxTXSU'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `openrouter/dots-studio/dots-3-note-preview:free`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 47. rotation — provider

**Error**

```
TypeError: 'NoneType' object is not subscriptable
```

**Responsible code**

- FlexFactor `flexfactor.py:2552` in `structured()`

```python
choice = resp.choices[0]
```
- Route: `openrouter/nvidia/nemotron-3.5-lightning:free`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 48. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '4df48b4f-e3c5-4ade-82c7-c06b65e25d18': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/ibm/granite-34b-code-instruct`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 49. rotation — budget

**Error**

```
APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. Visit your billing tab.', 'type': 'payment_required_error', 'param': 'quota', 'code': 'payment_required'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `cerebras/gemma-4-31b`

**Suggested fix** (signature)

The provider's allowance for this key is spent (OpenRouter's free tier is balance-bound). The rotator cools that pool and moves on; it recovers when the allowance resets. Do not add paid credit to compensate.

### 50. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 18656, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-20b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 51. rotation — provider

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

### 52. rotation — provider

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

### 53. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-31b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 54. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/qwen3.6:35b-a3b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 55. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'f6b06895-d073-4714-8bb2-26c09e9f6597': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/meta/codellama-70b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 56. rotation — provider

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

### 57. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-safeguard-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 18334, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-safeguard-20b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 58. rotation — provider

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

### 59. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-26b-a4b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 60. rotation — provider

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

### 61. rotation — provider

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

### 62. rotation — provider

**Error**

```
TypeError: 'NoneType' object is not subscriptable
```

**Responsible code**

- FlexFactor `flexfactor.py:2552` in `structured()`

```python
choice = resp.choices[0]
```
- Route: `openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 63. fix — program-defect

**Error**

```
Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- Program file: `src/api/foundations.js`

**Suggested fix** (none)

no known fix; start from the responsible code above (model suggester failed: 'NoneType' object is not subscriptable)

### 64. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/mirage335/Qwen3-Coder-30b-virtuoso:latest`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 65. rotation — provider

**Error**

```
APITimeoutError: Request timed out.
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/meta/llama-3.2-90b-vision-instruct`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 66. rotation — provider

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

### 67. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-120b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 33475, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-120b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 68. rotation — provider

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

### 69. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 16000, model: gemma-4-31b\nPlease retry in 46.539875225s.', 'status': 'RESOURCE_EXHAUSTED', 'details': [{'@type': 'type.googleapis.com/google.rpc.Help', 'links': [{'description': 'Learn more about Gemini API quotas', 'url': 'https://ai.google.dev/gemini-api/docs/rate-limits'}]}, {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [{'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', 'quotaId': 'GenerateContentInputTokensPerModelPerMinute-FreeTier', 'quotaDimensions': {'location': 'global', 'model': 'gemma-4-31b'}, 'quotaValue': '16000'}]}, {'@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '46s'}]}}]
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `gemini/gemma-4-31b-it`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 70. rotation — provider

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

### 71. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '2fddadfb-7e76-4c8a-9b82-f7d3fab94471': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/meta/llama2-70b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 72. rotation — provider

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

### 73. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.6-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12790, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/qwen/qwen3.6-27b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 74. rotation — provider

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

### 75. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-31b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 76. rotation — flexfactor-defect

**Error**

```
OutputBudgetError: Model output hit the 16384-token budget (file too large to regenerate in one response); raise max_tokens for this call.
```

**Responsible code**

- FlexFactor `flexfactor.py:2559` in `structured()`

```python
raise OutputBudgetError(
```
- Route: `openrouter/nvidia/nemotron-3-super-120b-a12b:free`

**Suggested fix** (signature)

The model's output was cut off by the budget. FlexFactor shrinks the unit of work and retries; if the file still cannot be regenerated, it is recorded as oversized for that model.

### 77. rotation — provider

**Error**

```
APITimeoutError: Request timed out.
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/meta/muse-glimmer-30b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 78. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/qwen3.6:35b-a3b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 79. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.8-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 24015, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/qwen/qwen3.8-27b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 80. rotation — provider

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

### 81. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '9a10b012-e6df-46fd-83b2-700dcbc75814': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/mistralai/codestral-22b-instruct-v0.1`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 82. rotation — provider

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

### 83. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 23708, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-20b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 84. rotation — provider

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

### 85. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/deepseek-r1:8b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 86. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-31b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 87. rotation — provider

**Error**

```
RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expected one of ['changed', 'contents', 'fixed_titles', 'notes']); len=1147 head='{"type": "object", "properties": {"changed": {"type": "boolean", "description": "True whenever ANY listed defect was fixed in-file; only false if the file is already correct or nothing can be safely c'
```

**Responsible code**

- FlexFactor `flexfactor.py:3048` in `_check_structured_type()`

```python
raise RuntimeError(
```
- Route: `nvidia_nim/nvidia/ising-calibration-1.5-31b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 88. rotation — budget

**Error**

```
APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. Visit your billing tab.', 'type': 'payment_required_error', 'param': 'quota', 'code': 'payment_required'}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `cerebras/gpt-oss-120b`

**Suggested fix** (signature)

The provider's allowance for this key is spent (OpenRouter's free tier is balance-bound). The rotator cools that pool and moves on; it recovers when the allowance resets. Do not add paid credit to compensate.

### 89. rotation — provider

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

### 90. rotation — provider

**Error**

```
TimeoutError: timed out
```

**Responsible code**

- FlexFactor `flexfactor.py:2755` in `_chat()`

```python
with self._opener.open(req, timeout=_ollama_http_timeout()) as resp:
```
- Route: `ollama/qwen2.5-coder:7b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 91. rotation — provider

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

### 92. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-120b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 18422, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-120b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 93. rotation — provider

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

### 94. rotation — provider

**Error**

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-31b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 95. rotation — provider

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

### 96. rotation — provider

**Error**

```
TypeError: 'NoneType' object is not subscriptable
```

**Responsible code**

- FlexFactor `flexfactor.py:2552` in `structured()`

```python
choice = resp.choices[0]
```
- Route: `openrouter/nvidia/nemotron-3.5-lightning:free`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 97. baseline-gate — program-defect

**Error**

```
review made no progress: three consecutive semantic review batches completed ZERO files (1 of 3595 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (none)

no known fix; start from the responsible code above (model suggester failed: 'NoneType' object is not subscriptable)