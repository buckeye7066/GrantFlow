# Crawler Defect Ledger (Evidence-based)

This ledger records defects encountered while implementing the crawler, and how they were fixed.

## 2026-01-10 — Cheerio ESM default import crash

- **Symptom**: `SyntaxError: The requested module 'cheerio' does not provide an export named 'default'`
- **Where**: HTML parser
- **Fix**: Switched to named import `import { load } from 'cheerio'`
- **Evidence**:
  - `npm run crawler:doctor` passes after fix
  - Artifacts generated in `artifacts/crawler/YYYY-MM-DD/`

## 2026-01-10 — Offline fixtures not readable on Windows file:// paths

- **Symptom**: SMOKE runs produced Track A entries from mock sources and failed to prove federal/state/county/tribal fixtures
- **Root cause**: Incorrect file URL construction and conversion:
  - `file://C:/...` vs `file:///C:/...`
  - using URL `.pathname` instead of `fileURLToPath()`
- **Fix**:
  - `pathToFileURL()` used for base URL construction
  - `fileURLToPath()` used for file fetch path conversion
- **Evidence**:
  - `crawler:doctor` now produces federal/state/county/tribal Track A records and a mock MCO Track B record

## 2026-01-10 — crawler:doctor ran unrelated repo tests

- **Symptom**: `crawler:doctor` triggered unrelated tests that ran the older comprehensive ZIP crawler and failed (null profile context)
- **Fix**: Scope doctor to only run crawler smoke tests:
  - `node --test tests/crawler/smoke/nationalCrawlerV2.test.js`

## 2026-01-10 — SQLite timestamp resolution caused nondeterministic “latest version” selection

- **Symptom**: Change-detection test sometimes read the same version row when multiple versions shared the same second-level `created_at`
- **Fix**:
  - Tests order by `fetched_at DESC, created_at DESC, rowid DESC`
  - Tests wait >1s between runs

## 2026-01-10 — Artifacts overwritten by multiple runs in the same day

- **Symptom**: `sample_output.json` and `failures.json` could be overwritten by subsequent test runs on the same day
- **Fix**: Write both:
  - `sample_output.<crawl_run_id>.json` and `failures.<crawl_run_id>.json` (preserved)
  - plus `sample_output.json` / `failures.json` as “latest”

## 2026-01-10 — Live-run HTTP failures preserved (signals, not defects)

Per review rules, third-party HTTP failures (403/404/429/5xx) are **not crawler defects** unless they cause instability.
They are preserved as historical signals in run artifacts.

- **Live run example**: `b75dc347-aff2-458c-8345-d3654941d106`
  - `https://www.ssa.gov/benefits/` → HTTP 403 (recorded)
  - `https://www.tn.gov/tenncare/long-term-services-supports/ecf-choices.html` → HTTP 404 (recorded)
  - Evidence:
    - `artifacts/crawler/2026-01-10/failures.b75dc347-aff2-458c-8345-d3654941d106.json`
