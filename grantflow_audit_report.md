# FlexFactor audit — GrantFLow

- **Project:** `C:\Users\firer\GrantFlow`
- **Branch:** `main`
- **Toolchains:** java, node, swift
- **Build verification:** NOT AVAILABLE — dependencies not installed for swift:ios/App/CapApp-SPM - build gate would false-fail. Fixes in this run were NOT build-verified.
- **Dependency bootstrap:** 1/2 install step(s) succeeded — a failed install can make the build gate red for reasons unrelated to the code
- **Files reviewed:** 1 of 3595 candidate(s)
- **FILE ACCOUNTING: 3595 candidate(s) = 1 reviewed + 3568 never_attempted + 24 review_incomplete + 2 skipped_known_clean**
- **MOSTLY SKIPPED: only 1 of 3595 candidate file(s) (0%) were reviewed.**
- **Defects found:** 9
- **Files fixed:** 0
- **Errors recorded:** 55 (see the Errors section below; ledger at `C:\Users\firer\.flexfactor\runs\grantflow-20260826-173358-556165-36728\errors.md`)
- **Baseline build:** passed
- **Unit tests added:** 0 (suite not run)
- **Button/UI (Playwright):** skipped
- **Cycles run:** 1
- **Providers:** rotation:groq/compound-mini
- **Git:** PROVIDER-OUTAGE ABORT on main: checkpoint preserved; no unverified commit created

## System inventory

**171627 entries accounted for.**

| Category | Count |
|---|---:|
| artifact-subtree | 50 |
| binary-asset | 1876 |
| configuration-documentation-or-data | 18364 |
| first-party-source | 151326 |
| reparse-directory | 11 |

The immutable run manifest contains the complete path-level inventory. Artifact, binary, and reparse entries are named and classified; they are not represented as line-reviewed source.

## Executable evidence

- **Evidence run:** `grantflow-20260826-173358-556165-36728`
- **Exact final commit:** `28e93e1e39b1f9871cc50b8b7a5a1b7d19c7be28`
- **Code map:** 4208 file(s), 18879 function(s), 1261 route(s), 3832 material control(s)
- **Function execution:** 0/16243 with invocation evidence
- **Route execution:** 0/1261
- **Control execution:** 0/3832
- **Changed-file rescan:** 0/0 (complete)
- **Blast radius:** 0 affected file(s); analysis ran
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
  - `idea:GrantForge` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for GrantForge
  - `idea:GrantManager` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for GrantManager
  - `web:searxng` - RuntimeError: FLEXFACTOR_SEARXNG_URL is not set

- **Ideas accepted as serving this program's purpose:** 3 (rejected 2 - the purpose contract, not the competitor, decides)

- **Bridged into the fix stream:** 0 of 5 candidate(s)
  - NOT bridged (2): OSMOSIS, OpenGrantStack/GrantReady-hub-SaaS - accepted idea did not map to a valid acceptance criterion
  - NOT bridged (2): GrantForge, GrantManager - idea rejected by the purpose contract
  - NOT bridged (1): Granty - not bridgeable (evidence=verified, reuse_mode=reference-only)

| Competitor | Kind | Licence | Reuse mode | Purpose mapping | Verdict | Fix stream | Adoptable idea |
|---|---|---|---|---|---|---|---|
| [OSMOSIS](https://github.com/osmosis-labs/osmosis) | oss | `Apache-2.0` | `direct-code-reuse` | acceptance #Acceptance criteria 6 (Hamilton and other portal handoffs) and 8 (authenticated end-to-end journey) are both directly addressed by this idea, making it essential to fulfill the program's authored purpose rather than a generic improvement. | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Automated portal credential management and session handling |
| [Granty](https://github.com/granty1/granty1) | oss | `UNKNOWN` | `reference-only` | acceptance #Acceptance criteria 6 (Hamilton and other portal handoffs) and 8 (authenticated end-to-end journey) require proper handling of portal authentication which is missing from current GrantFlow implementation. This idea would fill that gap directly without diverting from the program's core purpose of honest, secure portal integration. | ACCEPT | NOT entered - not bridgeable (evidence=verified, reuse_mode=reference-only) | Automated portal credential synchronization and session management |
| [OpenGrantStack/GrantReady-hub-SaaS](https://github.com/OpenGrantStack/GrantReady-hub-SaaS) | oss | `Apache-2.0` | `direct-code-reuse` | acceptance #The program must have 'authenticated end-to-end journey' (#8) and 'Hamilton and other portal handoffs' (#6) to fulfill its purpose. These are not present in GrantFlow as evidenced by the file listing and lack of such components. | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Authenticated end-to-end journey with portal handoffs |
| [GrantForge](https://grantforge.tech/) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [GrantManager](https://www.indeed.com/q-Grant-Manager-l-North-Carolina-jobs.html) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |

### OSMOSIS

- **Evidence:** <https://github.com/osmosis-labs/osmosis>, <https://github.com/rchipka/node-osmosis>
- **Licence:** `Apache-2.0` (via github-api)
- **Reuse mode:** `direct-code-reuse` - licence Apache-2.0 is permissive and compatible; source may be read and adapted with attribution
- **Idea:** Automated portal credential management and session handling - OSMOSIS implements a structured approach to managing portal credentials and maintaining sessions across different funding platforms, including Hamilton and other portals, with explicit handling of 2FA and authentication flows.
- **Value here:** This capability directly addresses acceptance criteria 6 (Hamilton and other portal handoffs) and 8 (authenticated end-to-end journey), which are critical to GrantFLow's purpose of honest portal integration and provenance tracking. Without this, the system cannot reliably authenticate users or maintain session state across external portals.
- **Purpose / criterion mapping:** acceptance #Acceptance criteria 6 (Hamilton and other portal handoffs) and 8 (authenticated end-to-end journey) are both directly addressed by this idea, making it essential to fulfill the program's authored purpose rather than a generic improvement. - The idea directly supports the audited program's purpose to 'handle portals/2FA/signatures honestly' and 'prove outcomes without overstating qualification or awards'. It enables proper authentication flows that are required for legitimate portal integration, which is part of the core workflow being built in GrantFLow.
- **Purpose verdict:** ACCEPTED - The idea directly supports the audited program's purpose to 'handle portals/2FA/signatures honestly' and 'prove outcomes without overstating qualification or awards'. It enables proper authentication flows that are required for legitimate portal integration, which is part of the core workflow being built in GrantFLow.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** From the file list, OSMOSIS has components like `src/components/hamilton/PortalSessionsCard.jsx`, `src/components/hamilton/HamiltonAutopilotAuthorization.jsx`, `src/components/hamilton/PortalSyncCard.jsx`, and `src/api/hamilton.js` which suggest structured portal credential handling and session management. The presence of `src/components/hamilton/liveLoginWindow.js` further indicates a mechanism for managing live login flows. (confidence high)

### Granty

- **Evidence:** <https://github.com/granty1/granty1>, <https://github.com/hbalasu1/Argimax_Granty>
- **Licence:** `UNKNOWN` (via github-api)
- **Reuse mode:** `reference-only` - licence UNKNOWN could not be verified; record the capability as a reference and copy nothing
- **Idea:** Automated portal credential synchronization and session management - A system that automatically manages user credentials for external portals (like Hamilton) and maintains active sessions to enable seamless, authenticated access without manual re-entry or interruption.
- **Value here:** This capability directly supports the audited program's purpose by enabling honest handling of portals/2FA/signatures and authenticated end-to-end journey as required in acceptance criteria. It reduces friction for users accessing external systems while maintaining security and provenance.
- **Purpose / criterion mapping:** acceptance #Acceptance criteria 6 (Hamilton and other portal handoffs) and 8 (authenticated end-to-end journey) require proper handling of portal authentication which is missing from current GrantFlow implementation. This idea would fill that gap directly without diverting from the program's core purpose of honest, secure portal integration. - This idea directly addresses acceptance criteria 6 (Hamilton and other portal handoffs) and 8 (authenticated end-to-end journey). It is essential to fulfill GrantFlow's purpose of handling portals/2FA/signatures honestly without overstating qualification or awards, as it ensures proper authentication throughout the workflow rather than relying on manual or insecure methods. The idea supports the core mission of providing a production-grade workflow that handles real portal interactions correctly, not just surface-level UI elements.
- **Purpose verdict:** ACCEPTED - This idea directly addresses acceptance criteria 6 (Hamilton and other portal handoffs) and 8 (authenticated end-to-end journey). It is essential to fulfill GrantFlow's purpose of handling portals/2FA/signatures honestly without overstating qualification or awards, as it ensures proper authentication throughout the workflow rather than relying on manual or insecure methods. The idea supports the core mission of providing a production-grade workflow that handles real portal interactions correctly, not just surface-level UI elements.
- **Fix-stream decision:** DID NOT enter the fix stream - not bridgeable (evidence=verified, reuse_mode=reference-only)
- **Evidence basis:** From the file list, we see components like `src/components/hamilton/PortalSessionsCard.jsx`, `src/components/hamilton/HamiltonAutopilotAuthorization.jsx`, and `src/components/hamilton/HamiltonTaskDrawer.jsx` which suggest portal integration exists but no clear evidence of automated credential handling or session lifecycle management as described in the competitor's functionality. (confidence medium)

### OpenGrantStack/GrantReady-hub-SaaS

- **Evidence:** <https://github.com/OpenGrantStack/GrantReady-hub-SaaS>
- **Licence:** `Apache-2.0` (via repo-rewards)
- **Reuse mode:** `direct-code-reuse` - licence Apache-2.0 is permissive and compatible; source may be read and adapted with attribution
- **Idea:** Authenticated end-to-end journey with portal handoffs - The competitor implements a robust system for handling authenticated user journeys through portals and 2FA/signatures, ensuring honest and traceable transitions between systems.
- **Value here:** This directly addresses acceptance criteria #6 (Hamilton and other portal handoffs) and #8 (authenticated end-to-end journey), which are explicitly required for GrantFlow's purpose contract. The audited program lacks these features entirely.
- **Purpose / criterion mapping:** acceptance #The program must have 'authenticated end-to-end journey' (#8) and 'Hamilton and other portal handoffs' (#6) to fulfill its purpose. These are not present in GrantFlow as evidenced by the file listing and lack of such components. - Adopting this idea directly serves the audited program's stated purpose: to handle portals/2FA/signatures honestly and prove outcomes without overstating qualification or awards. This feature is a core requirement for the program's authorized functionality and directly closes gap #6 and #8 in its acceptance criteria, which are prerequisites for fulfilling the overall purpose contract.
- **Purpose verdict:** ACCEPTED - Adopting this idea directly serves the audited program's stated purpose: to handle portals/2FA/signatures honestly and prove outcomes without overstating qualification or awards. This feature is a core requirement for the program's authorized functionality and directly closes gap #6 and #8 in its acceptance criteria, which are prerequisites for fulfilling the overall purpose contract.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** The competitor's overview states: 'Enterprise-grade mobile collaboration platform for grant management teams' with 'secure collaboration, approval workflows' and 'HamiltonAutopilotAuthorization'. These imply portal authentication and handoff mechanisms not present in the GrantFlow codebase as evidenced by the lack of such components in the listed files. (confidence high)

### GrantForge

- **Evidence:** <https://grantforge.tech/>, <https://grantforge.ai/>, <https://grant-forge-ai.com/index.html>, <https://github.com/ddanntheman/GrantForge>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: every strong pool failed this call; last error was APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12638, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: every strong pool failed this call; last error was APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12638, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### GrantManager

- **Evidence:** <https://www.indeed.com/q-Grant-Manager-l-North-Carolina-jobs.html>, <https://pagrants.fema.gov/>, <https://www.indeed.com/q-Grants-Manager-l-North-Carolina-jobs.html>, <https://github.com/JosephPBaruch/grantManager>, <https://github.com/IsaacSchemm/GrantManager>, <https://github.com/Engrbrain/GrantManager>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Error code: 404
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: Error code: 404
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
- `(purpose)` line 0 (quality-gate) - **Purpose assessment evidence is incomplete**: baseline purpose assessment incomplete: 2/3 sample(s) usable; HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20384 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":20384,"n_ctx":16384}}; final purpose assessment returned no usable result _Suggested fix:_ Retry the resumable run after restoring a responsive provider.

### medium (1)
- `src/api/foundations.js` line 11 (error-handling) - **Missing error handling**: The API call does not return an error when the request fails or the server returns an error _Suggested fix:_ Wrap the API call in a try-catch block to handle errors

### low (1)
- `src/api/foundations.js` line 86 (edge-case) - **Potential null value**: The function assumes that the 'month' parameter is always provided _Suggested fix:_ Add a check to handle the case where 'month' is undefined or null

## Defects by file

### `src/api/foundations.js` ⚠️ reported
- **[medium]** line 11 (error-handling) — **Missing error handling**: The API call does not return an error when the request fails or the server returns an error _Fix:_ Wrap the API call in a try-catch block to handle errors
- **[low]** line 86 (edge-case) — **Potential null value**: The function assumes that the 'month' parameter is always provided _Fix:_ Add a check to handle the case where 'month' is undefined or null

## Fix notes / left unfixed

- src/main.jsx: NO-OP - author model returned no change for 1 finding(s): (b) The failing test and the [INEFFECTIVE_DYNAMIC_IMPORT] warning are related to data and cross-file issues; this file does not contain any fixable defects by itself.
- src/main.jsx: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- publication failure made no progress and did not name another repairable source file
- baseline publication suite is red and bounded repair did not fix it; review continued, publication stays blocked
- review made no progress: three consecutive semantic review batches completed ZERO files (1 of 3595 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
- rollback failed; working tree requires inspection


## Errors (55)

| # | phase | kind | error | responsible |
|---|---|---|---|---|
| 1 | rotation | provider | InternalServerError: Error code: 503 - [{'error': {'code': 503, 'message': 'This model is  | flexfactor.py:2412 |
| 2 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 3 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 4 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 5 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 6 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 7 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 8 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 9 | rotation | provider | JSONDecodeError: Invalid \escape: line 3 column 572 (char 592) | flexfactor.py:2563 |
| 10 | fix | program-defect | Invalid \escape: line 3 column 572 (char 592) | tests/unit/public-source-profile-privacy.test.mjs |
| 11 | fix | budget | no strong route available (121 enabled routes in catalog). Pools skipped: cerebras:free-ti | src/main.jsx |
| 12 | fix | budget | no strong route available (121 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/public-source-profile-privacy.test.mjs |
| 13 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 14 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 15 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 16 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 17 | baseline | program-defect | baseline publication suite is RED and bounded targeted repair did not fix it | - |
| 18 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 19 | rotation | budget | RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your c | flexfactor.py:2412 |
| 20 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request Entity Too Large', 'type' | flexfactor.py:2412 |
| 21 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 22 | rotation | provider | BadRequestError: Error code: 400 - {'error': {'message': 'Please reduce the length of the  | flexfactor.py:2412 |
| 23 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 24 | rotation | provider | HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20384 tok | flexfactor.py:2763 |
| 25 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 26 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 27 | rotation | budget | APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. V | flexfactor.py:2412 |
| 28 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 29 | rotation | budget | APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. V | flexfactor.py:2412 |
| 30 | rotation | budget | APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. V | flexfactor.py:2412 |
| 31 | rotation | provider | NotFoundError: Error code: 404 | flexfactor.py:2412 |
| 32 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 33 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 34 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 35 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 36 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 37 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 38 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 39 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `open | flexfactor.py:2412 |
| 40 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 41 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 42 | rotation | provider | HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (17201 tok | flexfactor.py:2763 |
| 43 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 44 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 45 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 46 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 47 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 48 | rotation | budget | APIStatusError: Error code: 402 - {'message': 'Payment required to access this resource. V | flexfactor.py:2412 |
| 49 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 50 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen | flexfactor.py:2412 |
| 51 | rotation | provider | JSONDecodeError: Expecting value: line 1 column 1 (char 0) | flexfactor.py:2563 |
| 52 | rotation | provider | RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expect | flexfactor.py:3048 |
| 53 | fix | program-defect | Expecting value: line 1 column 1 (char 0) | src/api/foundations.js |
| 54 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 55 | baseline-gate | program-defect | review made no progress: three consecutive semantic review batches completed ZERO files (1 | - |

Counts by kind: budget 7, program-defect 4, provider 44

### 1. rotation — provider

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

### 2. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.6-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 22823, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
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

### 4. rotation — provider

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

### 5. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'b0fcd392-e905-4ab4-8eb9-aeae95c30b37': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/nvidia/nemotron-4-340b-instruct`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 6. rotation — provider

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

### 7. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-safeguard-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 13122, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-safeguard-20b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 8. rotation — provider

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

### 9. rotation — provider

**Error**

```
JSONDecodeError: Invalid \escape: line 3 column 572 (char 592)
```

**Responsible code**

- FlexFactor `flexfactor.py:2563` in `structured()`

```python
data = json.loads(text)
```
- Route: `gemini/gemma-4-26b-a4b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 10. fix — program-defect

**Error**

```
Invalid \escape: line 3 column 572 (char 592)
```

**Responsible code**

- Program file: `tests/unit/public-source-profile-privacy.test.mjs`

**Suggested fix** (none)

no known fix; start from the responsible code above (model suggester failed: no light route available (121 enabled routes in catalog). Pools skipped: gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)))

### 11. fix — budget

**Error**

```
no strong route available (121 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `src/main.jsx`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 12. fix — budget

**Error**

```
no strong route available (121 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/public-source-profile-privacy.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 13. rotation — provider

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

### 14. rotation — provider

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

### 15. rotation — provider

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

### 16. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.8-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 21295, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/qwen/qwen3.8-27b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 17. baseline — program-defect

**Error**

```
baseline publication suite is RED and bounded targeted repair did not fix it
```

**Detail**

```
✔ never prospects the operator's own organizations (dedupe by name/EIN) (1.6482ms)
✔ enrichment runs with bounded concurrency (parallel, not serial) (13.9879ms)
✔ runYanaDiscovery surfaces prospect funnel in the summary (12.0979ms)
✔ YANA_TARGET_AREAS focuses OSM anchors + ProPublica states (owner geographic focus) (3.2381ms)
✔ caller-pinned per-source geography WINS over target areas (1.4009ms)
ℹ tests 3089
ℹ suites 129
ℹ pass 3088
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 332995.5034

✖ failing tests:

test at tests\unit\public-source-profile-privacy.test.mjs:209:1
✖ public source tree contains no known real-profile identifier or full-name marker (22197.8019ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
  + [
  +   'grantflow_run_manifest_20260828T103145803956.json:24302: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260828T120957048498.json:24253: private Windows account or mailbox alias'
  + ]
  - []
  
      at TestContext.<anonymous> (file:///C:/Users/firer/GrantFlow/tests/unit/public-source-profile-privacy.test.mjs:228:10)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'grantflow_run_manifest_20260828T103145803956.json:24302: private Windows account or mailbox alias', 'grantflow_run_manifest_202608
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (signature)

Read the full log at C:\Users\firer\.flexfactor\runs\grantflow-20260826-173358-556165-36728\baseline-publication-failure.log. Publication (push/merge) stays refused while the baseline is red; the review still runs.

### 18. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '20f2537e-8593-4eb9-ad40-60eee3bbaa55': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/microsoft/phi-3-vision-128k-instruct`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 19. rotation — budget

**Error**

```
RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\nPlease retry in 25.329879172s.', 'status': 'RESOURCE_EXHAUSTED', 'details': [{'@type': 'type.googleapis.com/google.rpc.Help', 'links': [{'description': 'Learn more about Gemini API quotas', 'url': 'https://ai.google.dev/gemini-api/docs/rate-limits'}]}, {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [{'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', 'quotaId': 'GenerateContentInputTokensPerModelPerDay-FreeTier', 'quotaDimensions': {'location': 'global', 'model': 'gemini-3.1-pro'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', 'quotaId': 'GenerateContentInputTokensPerModelPerMinute-FreeTier', 'quotaDimensions': {'location': 'global', 'model': 'gemini-3.1-pro'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests', 'quotaId': 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'quotaDimensions': {'location': 'global', 'model': 'gemini-3.1-pro'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests', 'quotaId': 'GenerateRequest
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `gemini/gemini-3.1-pro-preview`

**Suggested fix** (signature)

The account's FREE DAILY allowance for that backend is spent - one allowance, however many models the catalog lists under it. FlexFactor now benches the whole allowance until the reset the provider named (X-RateLimit-Reset) instead of re-testing it every 60s, and the run continues on other backends. It returns by itself at the daily reset; do not add paid credit to compensate. If a run must not depend on it, point the run at a backend with headroom rather than waiting.

### 20. rotation — provider

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

### 21. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'e6cab982-62f4-481e-9a7a-3dedb87dbd01': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/microsoft/phi-3.5-moe-instruct`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 22. rotation — provider

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

### 23. rotation — provider

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

### 24. rotation — provider

**Error**

```
HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20384 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":20384,"n_ctx":16384}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2763` in `_chat()`

```python
raise enriched from http_exc
```
- Route: `ollama/deepseek-r1:8b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 25. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 27754, Requested 7836. Please try again in 11.18s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 26. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'c53ee0e9-bad9-4e09-b365-52c9d6b71254': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/nvidia/nemotron-4-340b-reward`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 27. rotation — budget

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

### 28. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-120b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12638, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-120b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 29. rotation — budget

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

### 30. rotation — budget

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

### 31. rotation — provider

**Error**

```
NotFoundError: Error code: 404
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/nvidia/nemotron-3.5-lightning-30b-a3b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 32. rotation — provider

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

### 33. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.6-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12776, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/qwen/qwen3.6-27b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 34. rotation — provider

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

### 35. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'bc205f8e-1740-40df-8d32-c4321763498a': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/nvidia/neva-22b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 36. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-safeguard-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12638, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-safeguard-20b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 37. rotation — provider

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

### 38. rotation — provider

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

### 39. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `openai/gpt-oss-20b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12638, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/openai/gpt-oss-20b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 40. rotation — provider

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

### 41. rotation — provider

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

### 42. rotation — provider

**Error**

```
HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (17201 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":17201,"n_ctx":16384}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2763` in `_chat()`

```python
raise enriched from http_exc
```
- Route: `ollama/deepseek-r1:8b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 43. rotation — provider

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

### 44. rotation — provider

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

### 45. rotation — provider

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

### 46. rotation — provider

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

### 47. rotation — provider

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

### 48. rotation — budget

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

### 49. rotation — provider

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

### 50. rotation — provider

**Error**

```
APIStatusError: Error code: 413 - {'error': {'message': 'Request too large for model `qwen/qwen3.8-27b` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 18292, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/qwen/qwen3.8-27b`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 51. rotation — provider

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

### 52. rotation — provider

**Error**

```
RuntimeError: Structured output matched no schema key (decoy/unrelated JSON object; expected one of ['suggestion']); len=0 head=''
```

**Responsible code**

- FlexFactor `flexfactor.py:3048` in `_check_structured_type()`

```python
raise RuntimeError(
```
- Route: `ollama/gpt-oss:20b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 53. fix — program-defect

**Error**

```
Expecting value: line 1 column 1 (char 0)
```

**Responsible code**

- Program file: `src/api/foundations.js`

**Suggested fix** (none)

no known fix; start from the responsible code above (model suggester failed: Structured output matched no schema key (decoy/unrelated JSON object; expected one of ['suggestion']); len=0 head='')

### 54. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'cd89bd68-13e3-47a9-861e-9a62e6e14b05': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/mistralai/mistral-7b-instruct-v0.3`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 55. baseline-gate — program-defect

**Error**

```
review made no progress: three consecutive semantic review batches completed ZERO files (1 of 3595 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (model)

model suggestion, unverified: The error points to a provider/route fault rather than a specific code issue, but the necessary details (e.g., the configuration file or module that defines the provider/route endpoint, and any related logs) are missing. Please supply the name and location of the provider/route configuration file and any error logs so we can pinpoint the misconfiguration or connectivity problem.