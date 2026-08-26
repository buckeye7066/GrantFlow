# Production readiness — GrantFlow

**Verdict: NOT PRODUCTION READY**

- Gates passed: 11/15 evaluated (18 total)
- Blocking failures: 6 (severity >= high)

## Blockers

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

## Detected toolchains

| Component | Ecosystem | Manager | Build | Test | Deps |
|---|---|---|---|---|---|
| `.` | node | npm | yes | yes | installed |
| `android` | java | gradle | yes | yes | installed |
| `android/app` | java | gradle | yes | yes | installed |
| `android/capacitor-cordova-android-plugins` | java | gradle | yes | yes | installed |
| `tools/eva-edge-runner` | node | npm | NONE | yes | installed |
| `tools/laptop-connector` | node | npm | NONE | none | installed |
| `ios/App/CapApp-SPM` | swift | swiftpm | yes | yes | MISSING |

## Bootstrap

- [ok] `npm install --ignore-scripts` in `tools/laptop-connector`
- [FAILED] `swift package resolve` in `ios/App/CapApp-SPM`
  - executable not found: swift ([WinError 2] The system cannot find the file specified)

## All gates

| Gate | Status | Severity | Evidence |
|---|---|---|---|
| Project builds | ???? | critical | build was not run |
| Changes can be build-verified | FAIL | critical | dependencies not installed for swift:ios/App/CapApp-SPM - build gate would false-fail |
| No secret material committed | PASS | critical | no secret-shaped files tracked |
| Dependencies are lock-pinned | FAIL | high | no lockfile: java:android, java:android/app, java:android/capacitor-cordova-android-plugins |
| .gitignore covers secrets and artifacts | PASS | high | .env ignored |
| Unique counters are minted on the server | PASS | high | no frontend unique-counter increment |
| No leftover factory overlay files at repo root | PASS | high | no tracked _gh_* / _restore_* at repo root |
| User-facing entities persist beyond in-memory stubs | FAIL | high | in-memory stub: backend/routes/grantScopedRecords.js (createStubEntityClient/in-memory stub), backend/routes/orgScopedRecords.js (createStubEntityClient/in-memory stub) |
| Fresh-DB schema bootstrap covers migrated tables | FAIL | high | fresh-DB miss: ingestion_runs (backend/db/migrations/001_add_ingestion_support.sql), crawler_jobs_new (backend/db/migrations/003_add_national_crawl_and_contact_info.sql), audit_logs (backend/db/migrations/004_audit_logs.sql), reviews (backend/db/migrations/008_add_reviews.sql), source_directory (backend/db/migrations/011_add_source_directory.sql) |
| Host spine modules are not collapsed stubs | PASS | high | spine modules present and not implausibly tiny |
| Test suite passes | ???? | high | tests were not run |
| Automated tests exist | PASS | high | test files found |
| Continuous integration is configured | PASS | medium | CI config found |
| Required configuration is documented | PASS | medium | .env.example present |
| Deployable artifact defined | PASS | medium | Dockerfile/Procfile present |
| README explains how to install and run | PASS | medium | README contains setup commands |
| License declared | PASS | low | license file present |
| JSON-LD structured data is valid | n/a | low | no JSON-LD blocks found |
