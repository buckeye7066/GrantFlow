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
- **Errors recorded:** 25 (see the Errors section below; ledger at `C:\Users\firer\.flexfactor\runs\grantflow-20260826-131141-932558-4264\errors.md`)
- **Baseline build:** passed
- **Unit tests added:** 0 (suite not run)
- **Button/UI (Playwright):** skipped
- **Cycles run:** 1
- **Providers:** rotation:groq/compound
- **Git:** PROVIDER-OUTAGE ABORT on main: checkpoint preserved; no unverified commit created

## System inventory

**171499 entries accounted for.**

| Category | Count |
|---|---:|
| artifact-subtree | 50 |
| binary-asset | 1834 |
| configuration-documentation-or-data | 18299 |
| first-party-source | 151305 |
| reparse-directory | 11 |

The immutable run manifest contains the complete path-level inventory. Artifact, binary, and reparse entries are named and classified; they are not represented as line-reviewed source.

## Executable evidence

- **Evidence run:** `grantflow-20260826-131141-932558-4264`
- **Exact final commit:** `614b5fcd740a11420598473e21921566bd85d149`
- **Code map:** 4199 file(s), 18878 function(s), 1261 route(s), 3832 material control(s)
- **Function execution:** 0/16243 with invocation evidence
- **Route execution:** 0/1261
- **Control execution:** 0/3832
- **Changed-file rescan:** 0/0 (complete)
- **Blast radius:** 0 affected file(s); analysis ran
- **Normalized gates:** 3 pass, 3 fail, 3 blocked

- **Blast Radius:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-131141-932558-4264\blast-radius.json`
- **Changed File Rescan:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-131141-932558-4264\changed-file-rescan.json`
- **Code Index:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-131141-932558-4264\code-index.json`
- **Coverage Ledger:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-131141-932558-4264\coverage-ledger.json`
- **Manifest:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-131141-932558-4264\manifest.json`
- **Purpose Graph:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-131141-932558-4264\purpose-graph.json`
- **Quality Gates:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-131141-932558-4264\quality-gates.json`
- **Sarif:** `C:\Users\firer\.flexfactor\evidence\b47e50f34e44ee5d\grantflow-20260826-131141-932558-4264\results.sarif`

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

- **Sources used:** web:duckduckgo, repo-rewards
- **Repo Rewards endpoint:** `https://web-production-d7db7.up.railway.app`
- **Sources SKIPPED (named, not silent):**
  - `idea:10 Best Grant Management Software In 2026 - flowforma.com` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for 10 Best Grant Management Software In 2026 - flowforma.com
  - `idea:Khalidkhann01/grant-proposal-automation` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for Khalidkhann01/grant-proposal-automation
  - `idea:damgooddata/GrantFlow360` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for damgooddata/GrantFlow360
  - `idea:grantflow-ai/grantflow` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for grantflow-ai/grantflow
  - `idea:worlds-biggest-software-project/226-grant-management-system` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for worlds-biggest-software-project/226-grant-management-system
  - `model-discovery` - RotationError: no light route available (102 enabled routes in catalog). Pools skipped: groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:dots-studio/dots-3-note-preview:free (openrouter:free-tier allowance exhausted (account-wide))
  - `web:searxng` - RuntimeError: FLEXFACTOR_SEARXNG_URL is not set

- **Ideas accepted as serving this program's purpose:** 0 (rejected 5 - the purpose contract, not the competitor, decides)

- **Bridged into the fix stream:** 0 of 5 candidate(s)
  - NOT bridged (5): 10 Best Grant Management Software In 2026 - flowforma.com, Khalidkhann01/grant-proposal-automation, damgooddata/GrantFlow360, grantflow-ai/grantflow, worlds-biggest-software-project/226-grant-management-system - idea rejected by the purpose contract

| Competitor | Kind | Licence | Reuse mode | Purpose mapping | Verdict | Fix stream | Adoptable idea |
|---|---|---|---|---|---|---|---|
| [grantflow-ai/grantflow](https://github.com/grantflow-ai/grantflow) | oss | `NOASSERTION` | `reference-only` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [Khalidkhann01/grant-proposal-automation](https://github.com/Khalidkhann01/grant-proposal-automation) | oss | `UNKNOWN` | `reference-only` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [10 Best Grant Management Software In 2026 - flowforma.com](https://www.flowforma.com/blog/best-grant-management-software) | market | `UNKNOWN` | `clean-room-from-documented-behavior` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [worlds-biggest-software-project/226-grant-management-system](https://github.com/worlds-biggest-software-project/226-grant-management-system) | oss | `UNKNOWN` | `reference-only` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [damgooddata/GrantFlow360](https://github.com/damgooddata/GrantFlow360) | oss | `UNKNOWN` | `reference-only` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |

### grantflow-ai/grantflow

- **Evidence:** <https://github.com/grantflow-ai/grantflow>
- **Licence:** `NOASSERTION` (via repo-rewards)
- **Reuse mode:** `reference-only` - licence NOASSERTION could not be verified; record the capability as a reference and copy nothing
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### Khalidkhann01/grant-proposal-automation

- **Evidence:** <https://github.com/Khalidkhann01/grant-proposal-automation>
- **Licence:** `UNKNOWN` (via repo-rewards)
- **Reuse mode:** `reference-only` - licence UNKNOWN could not be verified; record the capability as a reference and copy nothing
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### 10 Best Grant Management Software In 2026 - flowforma.com

- **Evidence:** <https://www.flowforma.com/blog/best-grant-management-software>, <https://www.liveimpact.org/blog/best-grant-management-software-for-nonprofits>, <https://opengrants.io/best-grant-management-software-for-nonprofits/>
- **Licence:** `UNKNOWN` (via none (no repository could be attributed to this competitor))
- **Reuse mode:** `clean-room-from-documented-behavior` - no inspectable source (licence UNKNOWN); only publicly documented behaviour may inform our own independent design
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### worlds-biggest-software-project/226-grant-management-system

- **Evidence:** <https://github.com/worlds-biggest-software-project/226-grant-management-system>
- **Licence:** `UNKNOWN` (via repo-rewards)
- **Reuse mode:** `reference-only` - licence UNKNOWN could not be verified; record the capability as a reference and copy nothing
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### damgooddata/GrantFlow360

- **Evidence:** <https://github.com/damgooddata/GrantFlow360>
- **Licence:** `UNKNOWN` (via repo-rewards)
- **Reuse mode:** `reference-only` - licence UNKNOWN could not be verified; record the capability as a reference and copy nothing
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
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
- `(purpose)` line 0 (quality-gate) - **Purpose assessment evidence is incomplete**: baseline purpose assessment failed: RuntimeError: all 3 purpose assessment samples failed: RotationError: no light route available (102 enabled routes in catalog). Pools skipped: groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:dots-studio/dots-3-note-preview:free (openrouter:free-tier allowance exhausted (account-wide)); RotationError: no light route available (102 enabled routes in catalog). Pools skipped: groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:dots-studio/dots-3-note-preview:free (openrouter:free-tier allowance exhausted (account-wide)); NotFoundError: Error code: 404; final purpose assessment returned no usable result _Suggested fix:_ Retry the resumable run after restoring a responsive provider.

## Defects by file

_No defects found in the reviewed files._

## Fix notes / left unfixed

- src/main.jsx: The publication suite failure is a cross-file product behavior issue. enforceBasename was removed from src/main.jsx to isolate the root cause; the function definition or its dependency lives elsewhere and requires changes outside this file.
- tests/unit/public-source-profile-privacy.test.mjs: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- src/main.jsx: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: TIMED OUT after 15m of fix attempts - rolled back and re-queued (raise FLEXFACTOR_FIX_FILE_MAX_SECONDS to allow longer)
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: THE FINDING IS WRONG for this file: The enforceBasename() call is intentionally commented out with a TODO noting it requires a product behavior fix to pass the failing publication test. It should remain disabled until that fix lands. The enforceCanonicalHost() function call is present and functional in the file. No unsafe edits needed beyond the comment removal.
- tests/unit/admin-integrity-repair.test.mjs: no verified candidate was produced
- tests/unit/admin-integrity-repair.test.mjs: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: no verified candidate was produced
- publication failure made no progress and did not name another repairable source file
- baseline publication suite is red and bounded repair did not fix it; review continued, publication stays blocked
- review made no progress: three consecutive semantic review batches completed ZERO files (0 of 3597 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
- rollback failed; working tree requires inspection


## Errors (25)

| # | phase | kind | error | responsible |
|---|---|---|---|---|
| 1 | fix | budget | no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/admin-integrity-repair.test.mjs |
| 2 | fix | budget | no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/admin-integrity-repair.test.mjs |
| 3 | fix | budget | no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/public-source-profile-privacy.test.mjs |
| 4 | fix | budget | no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-ti | src/main.jsx |
| 5 | fix | budget | no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/public-source-profile-privacy.test.mjs |
| 6 | fix | budget | no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-ti | src/main.jsx |
| 7 | baseline | program-defect | baseline publication suite is RED and bounded targeted repair did not fix it | - |
| 8 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 9 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 10 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 11 | rotation | provider | NotFoundError: Error code: 404 | flexfactor.py:2412 |
| 12 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 13 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 14 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 15 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 16 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 17 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 18 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 19 | rotation | provider | BadRequestError: Error code: 400 - {'error': {'message': 'Please reduce the length of the  | flexfactor.py:2412 |
| 20 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 21 | rotation | provider | TimeoutError: timed out | flexfactor.py:2755 |
| 22 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request Entity Too Large', 'type' | flexfactor.py:2412 |
| 23 | rotation | provider | BadRequestError: Error code: 400 - {'error': {'message': 'Please reduce the length of the  | flexfactor.py:2412 |
| 24 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 25 | baseline-gate | program-defect | review made no progress: three consecutive semantic review batches completed ZERO files (0 | - |

Counts by kind: budget 6, program-defect 2, provider 17

### 1. fix — budget

**Error**

```
no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/admin-integrity-repair.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 2. fix — budget

**Error**

```
no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/admin-integrity-repair.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 3. fix — budget

**Error**

```
no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/public-source-profile-privacy.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 4. fix — budget

**Error**

```
no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `src/main.jsx`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 5. fix — budget

**Error**

```
no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/public-source-profile-privacy.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 6. fix — budget

**Error**

```
no strong route available (102 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `src/main.jsx`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 7. baseline — program-defect

**Error**

```
baseline publication suite is RED and bounded targeted repair did not fix it
```

**Detail**

```
✔ enrichment runs with bounded concurrency (parallel, not serial) (15.6069ms)
✔ runYanaDiscovery surfaces prospect funnel in the summary (14.5726ms)
✔ YANA_TARGET_AREAS focuses OSM anchors + ProPublica states (owner geographic focus) (3.8733ms)
✔ caller-pinned per-source geography WINS over target areas (1.2273ms)
ℹ tests 3089
ℹ suites 129
ℹ pass 3088
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 522371.918

✖ failing tests:

test at tests\unit\public-source-profile-privacy.test.mjs:199:1
✖ public source tree contains no known real-profile identifier or full-name marker (18633.2136ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
  + [
  +   'grantflow_audit_report.md:3: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T053800755390.json:24265: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T114803768100.json:24253: private Windows account or mailbox alias'
  + ]
  - []
  
      at TestContext.<anonymous> (file:///C:/Users/firer/GrantFlow/tests/unit/public-source-profile-privacy.test.mjs:218:10)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'grantflow_audit_report.md:3: private Windows account or mailbox alias', 'grantflow_run_manifest_20260826T053800755390.json:24265: priva
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (signature)

Read the full log at C:\Users\firer\.flexfactor\runs\grantflow-20260826-131141-932558-4264\baseline-publication-failure.log. Publication (push/merge) stays refused while the baseline is red; the review still runs.

### 8. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19793, Requested 23686. Please try again in 26.958s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

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
- Route: `ollama/gemma4:26b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 11. rotation — provider

**Error**

```
NotFoundError: Error code: 404
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/moonshotai/kimi-k3`

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
- Route: `ollama/gemma4:e4b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 13. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19807, Requested 23686. Please try again in 26.985999999s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

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
- Route: `ollama/qwen2.5-coder:7b`

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
- Route: `ollama/gpt-oss:20b`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 16. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '67324577-3f91-4aa6-b750-97468262530d': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/ibm/granite-3.0-3b-a800m-instruct`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 17. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19783, Requested 23686. Please try again in 26.938s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 18. rotation — provider

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

### 19. rotation — provider

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

### 20. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19865, Requested 23686. Please try again in 27.102s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 21. rotation — provider

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

### 22. rotation — provider

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

### 23. rotation — provider

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

### 24. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19794, Requested 23686. Please try again in 26.959999999s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 25. baseline-gate — program-defect

**Error**

```
review made no progress: three consecutive semantic review batches completed ZERO files (0 of 3597 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (none)

no known fix; start from the responsible code above (model suggester failed: no light route available (102 enabled routes in catalog). Pools skipped: groq:free-tier (pool cooling down); local:ollama (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:dots-studio/dots-3-note-preview:free (openrouter:free-tier allowance exhausted (account-wide)))