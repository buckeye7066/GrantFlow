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
- **Errors recorded:** 17 (see the Errors section below; ledger at `C:\Users\firer\.flexfactor\runs\grantflow-20260826-064954-499246-31220\errors.md`)
- **Baseline build:** passed
- **Unit tests added:** 0 (suite not run)
- **Button/UI (Playwright):** skipped
- **Cycles run:** 1
- **Providers:** rotation:nvidia/nemotron-parse
- **Git:** PROVIDER-OUTAGE ABORT on main: checkpoint preserved; no unverified commit created

## System inventory

**171490 entries accounted for.**

| Category | Count |
|---|---:|
| artifact-subtree | 50 |
| binary-asset | 1830 |
| configuration-documentation-or-data | 18294 |
| first-party-source | 151305 |
| reparse-directory | 11 |

The immutable run manifest contains the complete path-level inventory. Artifact, binary, and reparse entries are named and classified; they are not represented as line-reviewed source.

## Executable evidence

- **Evidence run:** `grantflow-20260826-064954-499246-31220`
- **Exact final commit:** `48fa2b1e2fb73e1f3e342cfe79afd247cbf45f63`
- **Code map:** 4198 file(s), 18878 function(s), 1261 route(s), 3832 material control(s)
- **Function execution:** 0/16243 with invocation evidence
- **Route execution:** 0/1261
- **Control execution:** 0/3832
- **Changed-file rescan:** 0/0 (complete)
- **Blast radius:** 0 affected file(s); analysis ran
- **Normalized gates:** 3 pass, 3 fail, 3 blocked

- **Blast Radius:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-064954-499246-31220\blast-radius.json`
- **Changed File Rescan:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-064954-499246-31220\changed-file-rescan.json`
- **Code Index:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-064954-499246-31220\code-index.json`
- **Coverage Ledger:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-064954-499246-31220\coverage-ledger.json`
- **Manifest:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-064954-499246-31220\manifest.json`
- **Purpose Graph:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-064954-499246-31220\purpose-graph.json`
- **Quality Gates:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-064954-499246-31220\quality-gates.json`
- **Sarif:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-064954-499246-31220\results.sarif`

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
  - `idea:OpenGrantStack/GrantReady-hub-SaaS` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for OpenGrantStack/GrantReady-hub-SaaS
  - `web:searxng` - RuntimeError: FLEXFACTOR_SEARXNG_URL is not set

- **Ideas accepted as serving this program's purpose:** 3 (rejected 2 - the purpose contract, not the competitor, decides)

- **Bridged into the fix stream:** 0 of 5 candidate(s)
  - NOT bridged (3): Fluxx, GrantHub, RockefellerArchiveCenter/fluxx_exporter - accepted idea did not map to a valid acceptance criterion
  - NOT bridged (2): OpenGrantStack/GrantReady-hub-SaaS, ritchiea/recessart - idea rejected by the purpose contract

| Competitor | Kind | Licence | Reuse mode | Purpose mapping | Verdict | Fix stream | Adoptable idea |
|---|---|---|---|---|---|---|---|
| [RockefellerArchiveCenter/fluxx_exporter](https://github.com/RockefellerArchiveCenter/fluxx_exporter) | oss | `MIT` | `direct-code-reuse` | acceptance #criterion_10 | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Structured export of grant profiles with provenance and direct-vs-directory classification |
| [ritchiea/recessart](https://github.com/ritchiea/recessart) | oss | `AGPL-3.0` | `clean-room-from-documented-behavior` | acceptance #The idea lacks concrete technical definition to verify if it serves the specific acceptance criteria (e.g., breaking link lifecycle, duplicate handling). It is too abstract to be actionable. | reject | NOT entered - idea rejected by the purpose contract | Fluxx Grant Management Domain Integration |
| [OpenGrantStack/GrantReady-hub-SaaS](https://github.com/OpenGrantStack/GrantReady-hub-SaaS) | oss | `Apache-2.0` | `direct-code-reuse` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [Fluxx](https://github.com/BinaryMuse/fluxxor) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | acceptance #Acceptance criterion 10: real output comparison against manual search (billing integration as part of outcome proof) | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Budget & invoicing module |
| [GrantHub](https://github.com/dulaz41/GrantHub) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | acceptance #1. authoritative matching/scoring contract | ACCEPT | NOT entered - accepted idea did not map to a valid acceptance criterion | Simple public grant-catalog search via duckduck-sourced crawler |

### RockefellerArchiveCenter/fluxx_exporter

- **Evidence:** <https://github.com/RockefellerArchiveCenter/fluxx_exporter>
- **Licence:** `MIT` (via repo-rewards)
- **Reuse mode:** `direct-code-reuse` - licence MIT is permissive and compatible; source may be read and adapted with attribution
- **Idea:** Structured export of grant profiles with provenance and direct-vs-directory classification - Provides a dedicated export endpoint that outputs each grant record as a structured JSON or CSV line including source URL, eligibility flags, direct-opportunity vs directory classification, and provenance chain — all machine-readable and auditable.
- **Value here:** Would give GrantFlow a single reliable artifact to satisfy acceptance criterion 10 (real output comparison against manual search) and criterion 9 (exact frontend/backend SHA), while also supporting provenance preservation and duplicate handling (criteria 2 and 4).
- **Purpose / criterion mapping:** acceptance #criterion_10 - Advances the program's authored purpose by enabling provenance-preserving output comparison, duplicate detection, and authoritative matching — all core to the purpose contract.
- **Purpose verdict:** ACCEPTED - Advances the program's authored purpose by enabling provenance-preserving output comparison, duplicate detection, and authoritative matching — all core to the purpose contract.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** The competitor repository is explicitly described as 'Select and export grant information from the Fluxx grants management system' and is MIT-licensed, permitting adaptation. No source code was read, but the repo name and description confirm the capability. (confidence medium)

### ritchiea/recessart

- **Evidence:** <https://github.com/ritchiea/recessart>
- **Licence:** `AGPL-3.0` (via repo-rewards)
- **Reuse mode:** `clean-room-from-documented-behavior` - licence AGPL-3.0 is copyleft/restricted; source must NOT be copied - work from documented behaviour only
- **Idea:** Fluxx Grant Management Domain Integration - The competitor 'recessart' is described as implementing 'Fluxx Grant Management for Recess Art', suggesting it utilizes or mirrors the domain logic of a specific, established grant management system named Fluxx.
- **Value here:** If Fluxx has superior logic for handling complex grant application lifecycles or portal integrations, adopting its patterns could help GrantFlow fulfill its purpose of 'authentic' handling and 'provenance'.
- **Purpose / criterion mapping:** acceptance #The idea lacks concrete technical definition to verify if it serves the specific acceptance criteria (e.g., breaking link lifecycle, duplicate handling). It is too abstract to be actionable. - The audited program's purpose requires 'one authoritative matching/scoring contract', 'current-source validation', and 'authentic portal handling'. Adopting a vague 'Fluxx pattern' provides no concrete mechanism to repair the 'red required publication suite' or close the gap with the stated purpose. Without specific evidence of *how* Fluxx differs or solves a defect in GrantFlow, this is not a value-adding adoption but an undefined reference. It fails the strict test of advancing the current state toward the authored purpose.
- **Purpose verdict:** REJECTED - The audited program's purpose requires 'one authoritative matching/scoring contract', 'current-source validation', and 'authentic portal handling'. Adopting a vague 'Fluxx pattern' provides no concrete mechanism to repair the 'red required publication suite' or close the gap with the stated purpose. Without specific evidence of *how* Fluxx differs or solves a defect in GrantFlow, this is not a value-adding adoption but an undefined reference. It fails the strict test of advancing the current state toward the authored purpose.
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:** The competitor evidence is extremely sparse: 'Fluxx Grant Management for Recess Art'. It does not describe any technical capability, architectural pattern, or unique feature. It only names a domain concept ('Fluxx'). There is no evidence that the competitor has solved a problem GrantFlow hasn't, nor any evidence of *what* those solutions are. The idea 'use Fluxx patterns' is abstract and undefined. (confidence low)

### OpenGrantStack/GrantReady-hub-SaaS

- **Evidence:** <https://github.com/OpenGrantStack/GrantReady-hub-SaaS>
- **Licence:** `Apache-2.0` (via repo-rewards)
- **Reuse mode:** `direct-code-reuse` - licence Apache-2.0 is permissive and compatible; source may be read and adapted with attribution
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: every strong pool failed this call; last error was NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '5beba52c-65a9-4f46-8cd9-656689a1b205': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: every strong pool failed this call; last error was NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '5beba52c-65a9-4f46-8cd9-656689a1b205': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### Fluxx

- **Evidence:** <https://github.com/BinaryMuse/fluxxor>, <https://github.com/thedumbtechguy/Fluxxan>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** Budget & invoicing module - Provides a dedicated billing and invoicing workflow for agencies that provide grant services to clients, including invoice generation, time tracking, and payment processing integrated with the grant pipeline.
- **Value here:** Integrates billing directly into the grant workflow, reducing manual admin overhead and improving revenue capture for service-oriented grant operations.
- **Purpose / criterion mapping:** acceptance #Acceptance criterion 10: real output comparison against manual search (billing integration as part of outcome proof) - The audited program's stated purpose includes 'Billing & invoicing – optional module for agencies that provide grant services to clients.' Adopting this idea directly advances that specific purpose clause.
- **Purpose verdict:** ACCEPTED - The audited program's stated purpose includes 'Billing & invoicing – optional module for agencies that provide grant services to clients.' Adopting this idea directly advances that specific purpose clause.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** Competitor's README lists 'Billing & invoicing – optional module for agencies that provide grant services to clients. (confidence medium)

### GrantHub

- **Evidence:** <https://github.com/dulaz41/GrantHub>, <https://github.com/KZhambyl/granthub-ai>, <https://github.com/ingferraguti/GrantHub>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** Simple public grant-catalog search via duckduck-sourced crawler - Provides an unauthenticated, keyword- based landing page that lists grant opportunities found by a lightweight crawler with minimal compliance overhead, surfacing basic fields (title, source, deadline, fit summary) without requiring a user account.
- **Value here:** Enables immediate public visibility of opportunities, drives top‑of‑funnel traffic, and validates demand before investing in authenticated pipelines – something GrantFlow's current state lacks a simple public listing for.
- **Purpose / criterion mapping:** acceptance #1. authoritative matching/scoring contract - Advances the purpose of finding real current profile‑specific official sources and proving outcomes without overstating qualification; a public catalog is a low‑overhead way to surface opportunities that align with GrantFlow's mission.
- **Purpose verdict:** ACCEPTED - Advances the purpose of finding real current profile‑specific official sources and proving outcomes without overstating qualification; a public catalog is a low‑overhead way to surface opportunities that align with GrantFlow's mission.
- **Fix-stream decision:** DID NOT enter the fix stream - accepted idea did not map to a valid acceptance criterion
- **Evidence basis:** The GrantHub repo is not inspectable (licence UNKNOWN); only documented behaviour from the DuckDuckGo search result and the granthub‑ai fork is available, which describes a public catalog listing. (confidence medium)

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
- `(purpose)` line 0 (quality-gate) - **Purpose assessment evidence is incomplete**: baseline purpose assessment incomplete: 2/3 sample(s) usable; HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20331 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":20331,"n_ctx":16384}}; final purpose assessment returned no usable result _Suggested fix:_ Retry the resumable run after restoring a responsive provider.

## Defects by file

_No defects found in the reviewed files._

## Fix notes / left unfixed

- src/main.jsx: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- src/main.jsx: no verified candidate was produced
- tests/unit/admin-integrity-repair.test.mjs: Defect is real but requires changes outside this file (backend server logic, environment, infrastructure). The test infrastructure failure (server did not become ready) is caused by missing email configuration and server startup issues, not by code bugs in this test file.
- tests/unit/public-source-profile-privacy.test.mjs: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: no verified candidate was produced
- publication failure made no progress and did not name another repairable source file
- baseline publication suite is red and bounded repair did not fix it; review continued, publication stays blocked
- review made no progress: three consecutive semantic review batches completed ZERO files (0 of 3597 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
- rollback failed; working tree requires inspection


## Errors (17)

| # | phase | kind | error | responsible |
|---|---|---|---|---|
| 1 | rotation | program-defect | EgressBlockedError: flexfactor_egress_blocked: payload contains ['cloud_token', 'password_ | flexfactor.py:1294 |
| 2 | fix | budget | no strong route available (120 enabled routes in catalog). Pools skipped: cerebras:free-ti | src/main.jsx |
| 3 | fix | budget | no strong route available (120 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/public-source-profile-privacy.test.mjs |
| 4 | fix | budget | no strong route available (120 enabled routes in catalog). Pools skipped: cerebras:free-ti | src/main.jsx |
| 5 | baseline | program-defect | baseline publication suite is RED and bounded targeted repair did not fix it | - |
| 6 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 7 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 8 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 9 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 10 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 11 | rotation | budget | RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your c | flexfactor.py:2412 |
| 12 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 13 | rotation | provider | HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20331 tok | flexfactor.py:2763 |
| 14 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 15 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 16 | rotation | provider | BadRequestError: Error code: 400 - {'object': 'error', 'message': 'Expected exactly one me | flexfactor.py:2412 |
| 17 | baseline-gate | program-defect | review made no progress: three consecutive semantic review batches completed ZERO files (0 | - |

Counts by kind: budget 4, program-defect 3, provider 10

### 1. rotation — program-defect

**Error**

```
EgressBlockedError: flexfactor_egress_blocked: payload contains ['cloud_token', 'password_assignment'] (near line(s) [434, 435]); refusing to send to a cloud model. Re-run with --redact to mask and send, --allow-sensitive to send anyway, or allow categories via FLEXFACTOR_ALLOW_EGRESS / ~/.flexfactor/policy.json {"allow_egress": [...]}.
```

**Responsible code**

- FlexFactor `flexfactor.py:1294` in `_egress_gate()`

```python
raise EgressBlockedError(
```
- Route: `cerebras/gemma-4-31b`

**Suggested fix** (signature)

The egress gate found a secret/PII pattern in repo-derived text and refused to send it to a cloud model. Remove the secret from the repo (or use --redact / FLEXFACTOR_ALLOW_EGRESS for a known-safe fixture).

### 2. fix — budget

**Error**

```
no strong route available (120 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `src/main.jsx`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 3. fix — budget

**Error**

```
no strong route available (120 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/public-source-profile-privacy.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 4. fix — budget

**Error**

```
no strong route available (120 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `src/main.jsx`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 5. baseline — program-defect

**Error**

```
baseline publication suite is RED and bounded targeted repair did not fix it
```

**Detail**

```
✔ never prospects the operator's own organizations (dedupe by name/EIN) (1.7714ms)
✔ enrichment runs with bounded concurrency (parallel, not serial) (14.349ms)
✔ runYanaDiscovery surfaces prospect funnel in the summary (11.8309ms)
✔ YANA_TARGET_AREAS focuses OSM anchors + ProPublica states (owner geographic focus) (3.1457ms)
✔ caller-pinned per-source geography WINS over target areas (1.2058ms)
ℹ tests 3089
ℹ suites 129
ℹ pass 3088
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 347959.9687

✖ failing tests:

test at tests\unit\public-source-profile-privacy.test.mjs:199:1
✖ public source tree contains no known real-profile identifier or full-name marker (7239.5917ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
  + [
  +   'grantflow_audit_report.md:3: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T053800755390.json:24265: private Windows account or mailbox alias'
  + ]
  - []
  
      at TestContext.<anonymous> (file:///C:/Users/firer/GrantFlow/tests/unit/public-source-profile-privacy.test.mjs:218:10)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'grantflow_audit_report.md:3: private Windows account or mailbox alias', 'grantflow_run_manifest_20260826T053800755390.json:24265: private Windows account or mai
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (signature)

Read the full log at C:\Users\firer\.flexfactor\runs\grantflow-20260826-064954-499246-31220\baseline-publication-failure.log. Publication (push/merge) stays refused while the baseline is red; the review still runs.

### 6. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'e2d298c5-204e-4213-b921-9f492cc9011b': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/google/codegemma-1.1-7b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 7. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19814, Requested 23681. Please try again in 26.99s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 8. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '7dfc10a8-3cc4-448e-97c1-2213308dc222': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/google/codegemma-7b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 9. rotation — provider

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

### 10. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function 'c322f327-55a3-4af3-a91f-c757e2b8b135': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/google/gemma-3-4b-it`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 11. rotation — budget

**Error**

```
RateLimitError: Error code: 429 - [{'error': {'code': 429, 'message': 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\nPlease retry in 34.885842103s.', 'status': 'RESOURCE_EXHAUSTED', 'details': [{'@type': 'type.googleapis.com/google.rpc.Help', 'links': [{'description': 'Learn more about Gemini API quotas', 'url': 'https://ai.google.dev/gemini-api/docs/rate-limits'}]}, {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [{'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests', 'quotaId': 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'quotaDimensions': {'model': 'gemini-3.1-pro', 'location': 'global'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests', 'quotaId': 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'quotaDimensions': {'model': 'gemini-3.1-pro', 'location': 'global'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', 'quotaId': 'GenerateContentInputTokensPerModelPerMinute-FreeTier', 'quotaDimensions': {'location': 'global', 'model': 'gemini-3.1-pro'}}, {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', 'quotaId': 'GenerateContent
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `gemini/gemini-3.1-pro-preview`

**Suggested fix** (signature)

The account's FREE DAILY allowance for that backend is spent - one allowance, however many models the catalog lists under it. FlexFactor now benches the whole allowance until the reset the provider named (X-RateLimit-Reset) instead of re-testing it every 60s, and the run continues on other backends. It returns by itself at the daily reset; do not add paid credit to compensate. If a run must not depend on it, point the run at a backend with headroom rather than waiting.

### 12. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19860, Requested 23681. Please try again in 27.082s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 13. rotation — provider

**Error**

```
HTTPError: HTTP Error 400: Bad Request: {"error":{"code":400,"message":"request (20331 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":20331,"n_ctx":16384}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2763` in `_chat()`

```python
raise enriched from http_exc
```
- Route: `ollama/deepseek-r1:8b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 14. rotation — provider

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
- Route: `ollama/phi4-mini:latest`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 16. rotation — provider

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

### 17. baseline-gate — program-defect

**Error**

```
review made no progress: three consecutive semantic review batches completed ZERO files (0 of 3597 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (none)

no known fix; start from the responsible code above (model suggester failed: Error code: 400 - {'object': 'error', 'message': 'Expected exactly one message. Expected exactly one message.', 'type': 'BadRequestError', 'param': None, 'code': 400})