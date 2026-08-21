# 2026-08-20 — medium daily findings root fixes

Owner ask: close the long-stuck GrantFlow medium findings by fixing the real code paths, not by quieting Sam/Anya.

## CHANGED

- **Amy crawler reliability / adapter_source_health**
  - `backend/services/crawlerOsService.js`
  - The production crawler DNS-rebinding guard no longer hard-fails public hosts solely because `dns.resolve()` had a bad minute. It now prefers the same OS resolver path the actual fetch uses (`lookup`) and falls back to `resolve` only when needed. This is the root-cause fix for public-host `source_fetch_failed` noise that was being misfiled as `sbir_gov` / `federal_register` source health.

- **Pipeline dollar-value answers / East Tennessee Foundation**
  - `backend/services/sources/listingPageAmountAdapter.js`
  - `backend/services/privateFoundationCrawler.js`
  - ETF’s umbrella grant landing pages now ride the listing-page amount adapter on **exact landing paths only**. The umbrella row now resolves to a real page read (`page_read:true`) with no fabricated sibling amount, so the sweep can persist an honest no-figure answer instead of leaving the host unreadable forever.
  - The private-foundation seed no longer fabricates a `$1,000–$50,000` ETF umbrella range. Its landing URL now points at the real apply-for-grants page and emits null min/max so amount enrichment must answer it honestly.

- **Database backup freshness**
  - `backend/services/ops/databaseBackup.js`
  - `scripts/restore-db.mjs`
  - Postgres backups no longer depend exclusively on `pg_dump` being present on PATH. When the CLI is absent, backup falls back to a verified gzip-compressed JSON export over the live SQL connection and still stamps `system_kv.backup_last_run` only after the artifact exists and parses. This is the durable code path Sam reads.
  - Restore now refuses these fallback JSON artifacts explicitly instead of misclassifying them as SQLite snapshots.

## VERIFIED

- `npx vitest run backend/tests/crawlerFetchTimeout.test.js backend/tests/listingPageAmountAdapter.test.js backend/tests/privateFoundationCrawler.test.js backend/tests/backupFreshness.test.js`
  - passes
- `npx eslint backend/services/crawlerOsService.js backend/services/sources/listingPageAmountAdapter.js backend/services/privateFoundationCrawler.js backend/services/ops/databaseBackup.js backend/tests/crawlerFetchTimeout.test.js backend/tests/listingPageAmountAdapter.test.js backend/tests/privateFoundationCrawler.test.js backend/tests/backupFreshness.test.js`
  - passes
- `npm run typecheck`
  - passes
- `npm run build`
  - passes

## UNKNOWN / NEXT HUMAN ACTION

- **Sam green in production for backup freshness still requires one real prod backup run.**
  - The nightly self-heal schedule already exists in code and will now be able to write a real freshness row even when `pg_dump` is missing, but this session cannot prove a live Railway/prod run completed without prod credentials/runtime access.
- **Amy weak_match count may not drop all the way to target from this PR alone.**
  - This change closes the proven public-host fetch fragility and the ETF amount honesty issue. If the remaining weak matches persist after deploy, they need a fresh post-deploy cohort read to identify which categories still reflect a real coverage/query problem rather than the repaired network/source-health path.
