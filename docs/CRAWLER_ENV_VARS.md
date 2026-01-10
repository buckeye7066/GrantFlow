# Crawler Environment Variables

This document lists crawler-related environment variables, their defaults, and where they are used.

## V2 National Funding Crawler (scripts)

These env vars control `crawler:smoke`, `crawler:run`, and `crawler:doctor`.

- `DATABASE_URL`
  - **Default**: `backend/data/grantflow.db`
  - **Used in**:
    - `scripts/crawler-smoke.mjs` lines 14–16
    - `scripts/crawler-run.mjs` lines 18–20
    - `scripts/crawler-doctor.mjs` lines 17–20

- `CRAWLER_MODE`
  - **Default**: `SMOKE_MODE`
  - **Used in**: `scripts/crawler-run.mjs` line 22

- `CRAWLER_STATE`
  - **Default**: unset
  - **Used in**: `scripts/crawler-run.mjs` lines 23–36

- `CRAWLER_USE_LIVE_SOURCES`
  - **Default**: `false` (offline fixtures)
  - **Used in**:
    - `scripts/crawler-smoke.mjs` line 19
    - `scripts/crawler-run.mjs` line 24
    - `scripts/crawler-doctor.mjs` lines 131–137

- `CRAWLER_MAX_SOURCES`
  - **Default**: `crawler:smoke` → `10`, `crawler:run` → `25`
  - **Used in**:
    - `scripts/crawler-smoke.mjs` line 20
    - `scripts/crawler-run.mjs` line 25
    - `scripts/crawler-doctor.mjs` lines 131–137

- `CRAWLER_MAX_URLS_PER_SOURCE`
  - **Default**: `crawler:smoke` → `6`, `crawler:run` → `12`
  - **Used in**:
    - `scripts/crawler-smoke.mjs` line 21
    - `scripts/crawler-run.mjs` line 26

- `CRAWLER_TIMEOUT_SECONDS`
  - **Default**: `25`
  - **Used in**:
    - `scripts/crawler-smoke.mjs` line 22
    - `scripts/crawler-run.mjs` line 27

## Continuous national programs crawler (optional)

This is the older “national programs” continuous runner (separate from V2 scripts) and can be enabled in the API server.

- `NATIONAL_PROGRAMS_CRAWLER_ENABLED`
  - **Default**: `false`
  - **Used in**: `backend/server.js` lines 877–908

- `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES`
  - **Default**: `360`
  - **Used in**: `backend/server.js` lines 879–882

- `NATIONAL_PROGRAMS_MAX_URLS`
  - **Default**: `200`
  - **Used in**: `backend/server.js` line 883

- `NATIONAL_PROGRAMS_MAX_DEPTH`
  - **Default**: `2`
  - **Used in**: `backend/server.js` line 884

## Notes

- The V2 crawler is designed to be **offline-first** for smoke tests. Live crawling requires `CRAWLER_USE_LIVE_SOURCES=true`.
- For production scheduling, prefer invoking `crawler:run` from a real scheduler (cron/worker) rather than running it inside the API server process.

