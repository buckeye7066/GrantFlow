# FlexFactor audit — GrantFlow

- **Project:** `C:\Users\firer\GrantFlow`
- **Branch:** `main`
- **Toolchains:** java, node, swift
- **Build verification:** NOT AVAILABLE — dependencies not installed for swift:ios/App/CapApp-SPM - build gate would false-fail. Fixes in this run were NOT build-verified.
- **Dependency bootstrap:** 1/2 install step(s) succeeded — a failed install can make the build gate red for reasons unrelated to the code
- **Files reviewed:** 0 of 3595 candidate(s)
- **FILE ACCOUNTING: 3595 candidate(s) = 0 reviewed + 3569 never_attempted + 24 review_incomplete + 2 skipped_known_clean**
- **ZERO WORK: not one of 3595 candidate file(s) was reviewed. This run did nothing; treat it as a FAILURE, not a clean repo.**
- **Defects found:** 7
- **Files fixed:** 0
- **Errors recorded:** 12 (see the Errors section below; ledger at `C:\Users\firer\.flexfactor\runs\grantflow-20260826-173358-556165-36728\errors.md`)
- **Baseline build:** passed
- **Unit tests added:** 0 (suite not run)
- **Button/UI (Playwright):** skipped
- **Cycles run:** 1
- **Providers:** rotation:allam-2-7b
- **Git:** PROVIDER-OUTAGE ABORT on main: checkpoint preserved; no unverified commit created

## System inventory

**171549 entries accounted for.**

| Category | Count |
|---|---:|
| artifact-subtree | 50 |
| binary-asset | 1857 |
| configuration-documentation-or-data | 18326 |
| first-party-source | 151305 |
| reparse-directory | 11 |

The immutable run manifest contains the complete path-level inventory. Artifact, binary, and reparse entries are named and classified; they are not represented as line-reviewed source.

## Executable evidence

- **Evidence run:** `grantflow-20260826-173358-556165-36728`
- **Exact final commit:** `aaf8a4f3004a13db19cbf2ba94ad33e55da25cf4`
- **Code map:** 4203 file(s), 18878 function(s), 1261 route(s), 3832 material control(s)
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

**Coverage:** ONLY 3 of the target 5 competitors could be corroborated from a reachable source. This is a coverage SHORTFALL, not evidence that fewer competitors exist.

- **Sources used:** web:duckduckgo, repo-rewards
- **Repo Rewards endpoint:** `https://web-production-d7db7.up.railway.app`
- **Sources SKIPPED (named, not silent):**
  - `idea:damgooddata/GrantFlow360` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for damgooddata/GrantFlow360
  - `idea:teddyagent741-droid/grantflow-active` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for teddyagent741-droid/grantflow-active
  - `idea:vassiliylakhonin/grantflow` - model returned an incomplete idea (missing why_valuable) - forced to accept=False for vassiliylakhonin/grantflow
  - `model-discovery` - RotationError: no light route available (110 enabled routes in catalog). Pools skipped: gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:dots-studio/dots-3-note-preview:free (openrouter:free-tier allowance exhausted (account-wide))
  - `web:searxng` - RuntimeError: FLEXFACTOR_SEARXNG_URL is not set

- **Ideas accepted as serving this program's purpose:** 0 (rejected 3 - the purpose contract, not the competitor, decides)

- **Bridged into the fix stream:** 0 of 3 candidate(s)
  - NOT bridged (3): damgooddata/GrantFlow360, teddyagent741-droid/grantflow-active, vassiliylakhonin/grantflow - idea rejected by the purpose contract

| Competitor | Kind | Licence | Reuse mode | Purpose mapping | Verdict | Fix stream | Adoptable idea |
|---|---|---|---|---|---|---|---|
| [vassiliylakhonin/grantflow](https://github.com/vassiliylakhonin/grantflow) | oss | `MIT` | `direct-code-reuse` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [damgooddata/GrantFlow360](https://github.com/damgooddata/GrantFlow360) | oss | `UNKNOWN` | `reference-only` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |
| [teddyagent741-droid/grantflow-active](https://github.com/teddyagent741-droid/grantflow-active) | oss | `NOASSERTION` | `reference-only` | purpose-only | reject | NOT entered - idea rejected by the purpose contract | (idea extraction failed) |

### vassiliylakhonin/grantflow

- **Evidence:** <https://github.com/vassiliylakhonin/grantflow>, <https://github.com/grantflow-ai/grantflow>
- **Licence:** `MIT` (via repo-rewards)
- **Reuse mode:** `direct-code-reuse` - licence MIT is permissive and compatible; source may be read and adapted with attribution
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### damgooddata/GrantFlow360

- **Evidence:** <https://github.com/damgooddata/GrantFlow360>
- **Licence:** `UNKNOWN` (via repo-rewards)
- **Reuse mode:** `reference-only` - licence UNKNOWN could not be verified; record the capability as a reference and copy nothing
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Fix-stream decision:** DID NOT enter the fix stream - idea rejected by the purpose contract
- **Evidence basis:**  (confidence ?)

### teddyagent741-droid/grantflow-active

- **Evidence:** <https://github.com/teddyagent741-droid/grantflow-active>
- **Licence:** `NOASSERTION` (via repo-rewards)
- **Reuse mode:** `reference-only` - licence NOASSERTION could not be verified; record the capability as a reference and copy nothing
- **Idea:** (idea extraction failed) - 
- **Value here:** 
- **Purpose / criterion mapping:** purpose-only - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
- **Purpose verdict:** REJECTED - NOT ACTED ON: model returned an incomplete idea (missing why_valuable) - forced to accept=False. not judged: no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
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
- `(purpose)` line 0 (quality-gate) - **Purpose assessment evidence is incomplete**: baseline purpose assessment failed: RuntimeError: all 3 purpose assessment samples failed: RotationError: no light route available (110 enabled routes in catalog). Pools skipped: gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:dots-studio/dots-3-note-preview:free (openrouter:free-tier allowance exhausted (account-wide)); RotationError: no light route available (110 enabled routes in catalog). Pools skipped: gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:dots-studio/dots-3-note-preview:free (openrouter:free-tier allowance exhausted (account-wide)); RotationError: no light route available (110 enabled routes in catalog). Pools skipped: gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:dots-studio/dots-3-note-preview:free (openrouter:free-tier allowance exhausted (account-wide)); final purpose assessment returned no usable result _Suggested fix:_ Retry the resumable run after restoring a responsive provider.

## Defects by file

_No defects found in the reviewed files._

## Fix notes / left unfixed

- src/main.jsx: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- src/main.jsx: no verified candidate was produced
- tests/unit/public-source-profile-privacy.test.mjs: no verified candidate was produced
- publication failure made no progress and did not name another repairable source file
- baseline publication suite is red and bounded repair did not fix it; review continued, publication stays blocked
- review made no progress: three consecutive semantic review batches completed ZERO files (0 of 3595 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
- rollback failed; working tree requires inspection


## Errors (12)

| # | phase | kind | error | responsible |
|---|---|---|---|---|
| 1 | fix | budget | no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-ti | src/main.jsx |
| 2 | fix | budget | no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/public-source-profile-privacy.test.mjs |
| 3 | fix | budget | no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-ti | src/main.jsx |
| 4 | fix | budget | no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-ti | tests/unit/public-source-profile-privacy.test.mjs |
| 5 | baseline | program-defect | baseline publication suite is RED and bounded targeted repair did not fix it | - |
| 6 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 7 | rotation | provider | NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function | flexfactor.py:2412 |
| 8 | rotation | provider | BadRequestError: Error code: 400 - {'error': {'message': 'Please reduce the length of the  | flexfactor.py:2412 |
| 9 | rotation | provider | BadRequestError: Error code: 400 - {'error': {'message': 'Please reduce the length of the  | flexfactor.py:2412 |
| 10 | rotation | provider | RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `met | flexfactor.py:2412 |
| 11 | rotation | provider | APIStatusError: Error code: 413 - {'error': {'message': 'Request Entity Too Large', 'type' | flexfactor.py:2412 |
| 12 | baseline-gate | program-defect | review made no progress: three consecutive semantic review batches completed ZERO files (0 | - |

Counts by kind: budget 4, program-defect 2, provider 6

### 1. fix — budget

**Error**

```
no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `src/main.jsx`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 2. fix — budget

**Error**

```
no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/public-source-profile-privacy.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 3. fix — budget

**Error**

```
no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `src/main.jsx`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 4. fix — budget

**Error**

```
no strong route available (110 enabled routes in catalog). Pools skipped: cerebras:free-tier (pool cooling down); gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide))
```

**Responsible code**

- Program file: `tests/unit/public-source-profile-privacy.test.mjs`

**Suggested fix** (signature)

The pool's allowance is spent. The rotator benches it until reset; check AI Time for the reset time. Do not add paid keys to compensate.

### 5. baseline — program-defect

**Error**

```
baseline publication suite is RED and bounded targeted repair did not fix it
```

**Detail**

```
ℹ tests 3089
ℹ suites 129
ℹ pass 3088
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 349550.8661

✖ failing tests:

test at tests\unit\public-source-profile-privacy.test.mjs:199:1
✖ public source tree contains no known real-profile identifier or full-name marker (16892.4317ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
  + [
  +   'grantflow_audit_report.md:3: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T053800755390.json:24265: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T114803768100.json:24253: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T164822778819.json:24253: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260826T212816337082.json:24267: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260827T030619820366.json:24253: private Windows account or mailbox alias',
  +   'grantflow_run_manifest_20260827T062520061239.json:24253: private Windows account or mailbox alias'
  + ]
  - []
  
      at TestContext.<anonymous> (file:///C:/Users/firer/GrantFlow/tests/unit/public-source-profile-privacy.test.mjs:218:10)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'grantflow_audit_report
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (signature)

Read the full log at C:\Users\firer\.flexfactor\runs\grantflow-20260826-173358-556165-36728\baseline-publication-failure.log. Publication (push/merge) stays refused while the baseline is red; the review still runs.

### 6. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '8378ffb2-51b0-4140-9684-dda1889373e6': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/zyphra/zamba2-7b-instruct`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 7. rotation — provider

**Error**

```
NotFoundError: Error code: 404 - {'status': 404, 'title': 'Not Found', 'detail': "Function '23bd454d-b225-49a3-8118-582a62fc51b8': Not found for account 'hvux_0rjHS6OiBfWXcZvKgoOaUBy_3UsQqq6I6IAz7I'"}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `nvidia_nim/01-ai/yi-large`

**Suggested fix** (none)

no known fix; start from the responsible code above

### 8. rotation — provider

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

### 9. rotation — provider

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

### 10. rotation — provider

**Error**

```
RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached for model `meta-llama/llama-4-scout-17b-16e-instruct` in organization `org_01kxhxdkh3e7nasshjpfbkzh11` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Used 19763, Requested 23681. Please try again in 26.888s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', 'type': 'compound', 'code': 'rate_limit_exceeded'}}
```

**Responsible code**

- FlexFactor `flexfactor.py:2412` in `_chat_create()`

```python
return client.chat.completions.create(**kwargs)
```
- Route: `groq/groq/compound`

**Suggested fix** (signature)

Rate-limited. The rotator cools the pool down and moves on; nothing to fix unless it recurs on every pool, which means the free tiers are exhausted for now.

### 11. rotation — provider

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

### 12. baseline-gate — program-defect

**Error**

```
review made no progress: three consecutive semantic review batches completed ZERO files (0 of 3595 candidate file(s) reviewed all run). This is a provider/route fault, NOT evidence the repo is clean - stopped fail-closed for resumable retry
```

**Responsible code**

- Not attributable to a specific line from the evidence recorded.

**Suggested fix** (none)

no known fix; start from the responsible code above (model suggester failed: no light route available (110 enabled routes in catalog). Pools skipped: gemini:free-tier (gemini:free-tier allowance exhausted (account-wide)); groq:free-tier (pool cooling down); nvidia_nim:free-tier (pool cooling down); openrouter:credits (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:cohere/north-mini-code:free (openrouter:free-tier allowance exhausted (account-wide)); openrouter:free:dots-studio/dots-3-note-preview:free (openrouter:free-tier allowance exhausted (account-wide)))