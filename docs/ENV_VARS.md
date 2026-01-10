# ENV Vars Inventory

This file is **generated** by `node scripts/inventory-env.mjs`.
It enumerates environment variables referenced in code and/or present in example env files.

## Summary

- Total vars: **108**
- Vars referenced in code: **96**
- Vars present in env templates: **56**

## Inventory

| Name | Referenced in code | Defined in templates | Notes |
| --- | --- | --- | --- |
| `ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `ADMIN_NAME` | Yes | Yes | Backend/Node |
| `ADMIN_PHONE` | Yes | No | Backend/Node |
| `ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ANALYTICS_WRITE_KEY` | No | Yes |  |
| `ANTHROPIC_API_KEY` | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ANYA_API_KEY` | Yes | No | Backend/Node |
| `ANYA_AUTONOMOUS_ENABLED` | Yes | Yes | Backend/Node |
| `ANYA_CLAUDE_MODEL` | No | Yes |  |
| `ANYA_CODE_CRAWL` | Yes | Yes | Backend/Node |
| `ANYA_CRAWLERS` | Yes | Yes | Backend/Node |
| `ANYA_DRY_RUN` | Yes | Yes | Backend/Node |
| `ANYA_FIX_CONSOLE` | Yes | Yes | Backend/Node |
| `ANYA_FIX_EMPTY_CATCH` | Yes | Yes | Backend/Node |
| `ANYA_FIX_ERRORS` | Yes | Yes | Backend/Node |
| `ANYA_FUNCTION_TESTS` | Yes | Yes | Backend/Node |
| `ANYA_MATCH_THRESHOLD` | Yes | Yes | Backend/Node |
| `ANYA_MAX_FILE_CHANGES` | Yes | Yes | Backend/Node |
| `ANYA_OPENAI_MODEL` | Yes | No | Backend/Node |
| `ANYA_RUN_ON_ADMIN_LOGIN` | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `ANYA_SAVE_GLOBAL` | Yes | Yes | Backend/Node |
| `ANYA_SCHEDULE` | Yes | Yes | Backend/Node |
| `ANYA_WAIT_COMPLETION` | Yes | Yes | Backend/Node |
| `API_BASE_URL` | Yes | No | Backend/Node |
| `API_URL` | Yes | No | Backend/Node |
| `APPLICATION_EMAIL` | Yes | No | Backend/Node |
| `APP_BASE_PATH` | Yes | No | Backend/Node |
| `ARTIFACTS_DIR` | Yes | No | Backend/Node |
| `AUTH_ACCESS_TOKEN_TTL` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_CODE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_RATE_LIMIT` | Yes | No | Backend/Node |
| `AUTH_EMAIL_RESEND_SECONDS` | Yes | Yes | Backend/Node |
| `AUTH_FACEBOOK_CLIENT_ID` | No | Yes |  |
| `AUTH_FACEBOOK_CLIENT_SECRET` | No | Yes |  |
| `AUTH_FRONTEND_APP_BASE` | Yes | Yes | Backend/Node |
| `AUTH_FRONTEND_URL` | Yes | Yes | Backend/Node |
| `AUTH_GOOGLE_CLIENT_ID` | No | Yes |  |
| `AUTH_GOOGLE_CLIENT_SECRET` | No | Yes |  |
| `AUTH_JWT_SECRET` | Yes | Yes | Backend/Node |
| `AUTH_OAUTH_STATE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_CODE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_RATE_LIMIT` | Yes | No | Backend/Node |
| `AUTH_PHONE_RESEND_SECONDS` | Yes | Yes | Backend/Node |
| `AUTH_PUBLIC_URL` | Yes | Yes | Backend/Node |
| `AUTH_REFRESH_TOKEN_TTL` | Yes | Yes | Backend/Node |
| `AUTH_YAHOO_CLIENT_ID` | No | Yes |  |
| `AUTH_YAHOO_CLIENT_SECRET` | No | Yes |  |
| `BACKEND_BASE_URL` | Yes | No | Backend/Node |
| `BULK_POPULATE_KEY` | Yes | No | Backend/Node |
| `CORS_ORIGIN` | Yes | Yes | Backend/Node |
| `CRAWLER_MAX_SOURCES` | Yes | No | Backend/Node |
| `CRAWLER_MAX_URLS_PER_SOURCE` | Yes | No | Backend/Node |
| `CRAWLER_MODE` | Yes | No | Backend/Node |
| `CRAWLER_STALE_DAYS` | Yes | No | Backend/Node |
| `CRAWLER_STATE` | Yes | No | Backend/Node |
| `CRAWLER_TIMEOUT_SECONDS` | Yes | No | Backend/Node |
| `CRAWLER_USE_LIVE_SOURCES` | Yes | No | Backend/Node |
| `DATABASE_PATH` | Yes | No | Backend/Node |
| `DATABASE_URL` | Yes | Yes | Backend/Node |
| `DB_PATH` | Yes | No | Backend/Node |
| `DEV` | Yes | No | Frontend (Vite) |
| `FIREBASE_API_KEY` | Yes | No | Backend/Node |
| `FIREBASE_APP_ID` | Yes | No | Backend/Node |
| `FIREBASE_AUTH_DOMAIN` | Yes | No | Backend/Node |
| `FIREBASE_MESSAGING_SENDER_ID` | Yes | No | Backend/Node |
| `FIREBASE_PROJECT_ID` | Yes | No | Backend/Node |
| `FIREBASE_STORAGE_BUCKET` | Yes | No | Backend/Node |
| `FORCE` | Yes | No | Backend/Node |
| `FROM_EMAIL` | Yes | Yes | Backend/Node |
| `FRONTEND_BASE_URL` | Yes | No | Backend/Node |
| `GOOGLE_API_KEY` | Yes | No | Backend/Node |
| `GOOGLE_SEARCH_CX` | Yes | No | Backend/Node |
| `JWT_SECRET` | Yes | No | Backend/Node |
| `LOG_LEVEL` | No | Yes |  |
| `NATIONAL_PROGRAMS_CRAWLER_ENABLED` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_DEPTH` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_URLS` | Yes | No | Backend/Node |
| `NODE_ENV` | Yes | Yes | Backend/Node |
| `OPENAI_API_KEY` | Yes | Yes | Backend/Node |
| `OPENAI_MODEL` | Yes | No | Backend/Node |
| `PORT` | Yes | Yes | Backend/Node |
| `PUBLIC_URL` | Yes | No | Backend/Node |
| `REQUEST_TIMEOUT_MS` | Yes | No | Backend/Node |
| `RESEND_API_KEY` | Yes | Yes | Backend/Node |
| `SEED_PATH` | Yes | No | Backend/Node |
| `SENTRY_DSN` | No | Yes |  |
| `SERVICE_APPLICATION_EMAIL` | Yes | No | Backend/Node |
| `SMOKE_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `SMOKE_BASE_PATH` | Yes | No | Backend/Node |
| `SMOKE_BASE_URL` | Yes | No | Backend/Node |
| `SMOKE_DEBUG` | Yes | No | Backend/Node |
| `SMOKE_MODE` | No | Yes |  |
| `SMOKE_TARGET_PATH` | Yes | No | Backend/Node |
| `TEST_EMAIL` | Yes | No | Backend/Node |
| `TWILIO_ACCOUNT_SID` | Yes | Yes | Backend/Node |
| `TWILIO_AUTH_TOKEN` | Yes | Yes | Backend/Node |
| `TWILIO_FROM_NUMBER` | Yes | No | Backend/Node |
| `TWILIO_MESSAGING_SERVICE_SID` | Yes | Yes | Backend/Node |
| `VERIFY_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `VERIFY_BASE_URL` | Yes | No | Backend/Node |
| `VITE_API_PROXY_TARGET` | No | Yes |  |
| `VITE_API_URL` | Yes | Yes | Frontend (Vite) |
| `VITE_APP_BASE` | Yes | Yes | Used in both backend + frontend |
| `VITE_ASSET_BASE` | Yes | No | Backend/Node |

## Usage locations (file + line ranges)

### `ADMIN_EMAIL`

- **Templates**:
  - `.env.example:3` = `your-admin-email@example.com`
  - `backend/.env.example:11` = `admin@grantflow.local`
  - `backend/env.example:10` = `admin@grantflow.local`
- **Code references**:
  - `backend/config/constants.js:L8` (process.env)
  - `backend/server.js:L59` (process.env)
  - `scripts/ensure-admin-user.mjs:L19` (process.env)

### `ADMIN_NAME`

- **Templates**:
  - `backend/.env.example:10` = `Local Admin`
  - `backend/env.example:9` = `Local Admin`
- **Code references**:
  - `backend/server.js:L58` (process.env)
  - `scripts/ensure-admin-user.mjs:L21` (process.env)

### `ADMIN_PHONE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/ensure-admin-user.mjs:L20` (process.env)

### `ADMIN_TOKEN`

- **Templates**:
  - `backend/.env.example:9` = `dev-admin-token`
  - `backend/env.example:8` = `dev-admin-token`
- **Code references**:
  - `backend/routes/anya.js:L19` (process.env)
  - `backend/server.js:L57–L563` (process.env)
  - `scripts/diagnose-anya.mjs:L20` (process.env)
  - `scripts/doctor.mjs:L69` (process.env)

### `ANALYTICS_WRITE_KEY`

- **Templates**:
  - `backend/env.example:87` = ``
- **Code references**: (none)

### `ANTHROPIC_API_KEY`

- **Templates**:
  - `.env.example:8` = `sk-ant-your-anthropic-api-key-here`
  - `backend/.env.example:23` = ``
  - `backend/env.example:40` = `sk-ant-your-anthropic-key`
- **Code references**:
  - `backend/routes/anya.js:L52–L111` (process.env)
  - `scripts/diagnose-anya.mjs:L26–L40` (process.env)
  - `scripts/test-anya-ai.mjs:L23–L101` (process.env)
  - `scripts/test-anya-full.mjs:L46` (process.env)
  - `test-anya-simple.js:L7` (process.env)

### `ANYA_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:2` = `your-secret-admin-token-here`
  - `backend/env.example:13` = `anya-dev-token`
- **Code references**:
  - `backend/routes/anya.js:L19` (process.env)
  - `backend/server.js:L57–L563` (process.env)
  - `scripts/diagnose-anya.mjs:L20` (process.env)

### `ANYA_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L452–L452` (process.env)

### `ANYA_AUTONOMOUS_ENABLED`

- **Templates**:
  - `backend/.env.example:32` = `false`
  - `backend/env.example:49` = `false`
- **Code references**:
  - `backend/server.js:L856` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L15` (process.env)
  - `scripts/check-anya-status.mjs:L23–L107` (process.env)

### `ANYA_CLAUDE_MODEL`

- **Templates**:
  - `.env.example:9` = `claude-sonnet-4-20250514`
- **Code references**: (none)

### `ANYA_CODE_CRAWL`

- **Templates**:
  - `backend/env.example:58` = `true              # Scan and fix code issues`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L24` (process.env)

### `ANYA_CRAWLERS`

- **Templates**:
  - `backend/env.example:60` = `true                # Run grant crawlers`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L26` (process.env)

### `ANYA_DRY_RUN`

- **Templates**:
  - `backend/env.example:74` = `false                # Dry run mode (no actual changes)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L38–L47` (process.env)

### `ANYA_FIX_CONSOLE`

- **Templates**:
  - `backend/env.example:63` = `true             # Fix console.log statements`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L35` (process.env)

### `ANYA_FIX_EMPTY_CATCH`

- **Templates**:
  - `backend/env.example:64` = `true         # Fix empty catch blocks`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L36` (process.env)

### `ANYA_FIX_ERRORS`

- **Templates**:
  - `backend/env.example:73` = `false             # Auto-fix found errors`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L46` (process.env)

### `ANYA_FUNCTION_TESTS`

- **Templates**:
  - `backend/env.example:59` = `true          # Test API endpoints`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L25` (process.env)

### `ANYA_MATCH_THRESHOLD`

- **Templates**:
  - `backend/env.example:68` = `80           # Min % match to save to profile (0-100)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L41` (process.env)

### `ANYA_MAX_FILE_CHANGES`

- **Templates**:
  - `backend/env.example:65` = `20          # Max files to modify per run`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L37` (process.env)

### `ANYA_OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L29` (process.env)

### `ANYA_RUN_ON_ADMIN_LOGIN`

- **Templates**:
  - `backend/env.example:53` = `false    # Run when admin logs in`
- **Code references**:
  - `backend/routes/auth.js:L1393` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L19` (process.env)

### `ANYA_RUN_ON_SCHEDULE`

- **Templates**:
  - `backend/env.example:54` = `false       # Run on schedule (cron)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L20` (process.env)

### `ANYA_RUN_ON_STARTUP`

- **Templates**:
  - `backend/.env.example:33` = `false`
  - `backend/env.example:52` = `false        # Run when server starts`
- **Code references**:
  - `backend/server.js:L858` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L18` (process.env)
  - `scripts/check-anya-status.mjs:L24` (process.env)

### `ANYA_SAVE_GLOBAL`

- **Templates**:
  - `backend/env.example:69` = `true             # Save all opportunities globally`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L42` (process.env)

### `ANYA_SCHEDULE`

- **Templates**:
  - `backend/env.example:55` = `0 3 * * *           # Cron schedule (default: 3 AM daily)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L30` (process.env)

### `ANYA_WAIT_COMPLETION`

- **Templates**:
  - `backend/env.example:70` = `false        # Wait for crawlers to complete`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L43` (process.env)

### `API_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-auth-diagnostics.mjs:L12` (process.env)
  - `tests/smoke/smoke.spec.mjs:L7` (process.env)

### `API_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/diagnose-anya.mjs:L19` (process.env)
  - `scripts/test-email-endpoint.mjs:L9` (process.env)

### `APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/profiles.js:L748` (process.env)

### `APP_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L125` (process.env)

### `ARTIFACTS_DIR`

- **Templates**: (not present)
- **Code references**:
  - `tests/smoke/playwright.config.mjs:L3–L4` (process.env)
  - `tests/smoke/smoke.spec.mjs:L6` (process.env)

### `AUTH_ACCESS_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:17` = `10800`
- **Code references**:
  - `backend/routes/auth.js:L99` (process.env)

### `AUTH_EMAIL_CODE_TTL`

- **Templates**:
  - `backend/env.example:19` = `600`
- **Code references**:
  - `backend/routes/auth.js:L101` (process.env)

### `AUTH_EMAIL_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L169` (process.env)

### `AUTH_EMAIL_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:20` = `45`
- **Code references**:
  - `backend/routes/auth.js:L102` (process.env)

### `AUTH_FACEBOOK_CLIENT_ID`

- **Templates**:
  - `backend/env.example:79` = `facebook-client-id`
- **Code references**: (none)

### `AUTH_FACEBOOK_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:80` = `facebook-client-secret`
- **Code references**: (none)

### `AUTH_FRONTEND_APP_BASE`

- **Templates**:
  - `backend/.env.example:19` = `/grantflow`
  - `backend/env.example:27` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L125` (process.env)

### `AUTH_FRONTEND_URL`

- **Templates**:
  - `backend/.env.example:18` = `http://localhost:5173`
  - `backend/env.example:26` = `http://localhost:5173`
- **Code references**:
  - `backend/routes/auth.js:L123` (process.env)

### `AUTH_GOOGLE_CLIENT_ID`

- **Templates**:
  - `backend/env.example:77` = `google-client-id`
- **Code references**: (none)

### `AUTH_GOOGLE_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:78` = `google-client-secret`
- **Code references**: (none)

### `AUTH_JWT_SECRET`

- **Templates**:
  - `backend/.env.example:16` = `dev-secret-change-me`
  - `backend/env.example:16` = `dev-secret-change-me`
- **Code references**:
  - `backend/routes/auth.js:L37` (process.env)
  - `backend/server.js:L427–L560` (process.env)

### `AUTH_OAUTH_STATE_TTL`

- **Templates**:
  - `backend/env.example:23` = `600`
- **Code references**:
  - `backend/routes/auth.js:L105` (process.env)

### `AUTH_PHONE_CODE_TTL`

- **Templates**:
  - `backend/env.example:21` = `600`
- **Code references**:
  - `backend/routes/auth.js:L103` (process.env)

### `AUTH_PHONE_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L176` (process.env)

### `AUTH_PHONE_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:22` = `60`
- **Code references**:
  - `backend/routes/auth.js:L104` (process.env)

### `AUTH_PUBLIC_URL`

- **Templates**:
  - `backend/.env.example:17` = `http://localhost:5173/grantflow`
  - `backend/env.example:25` = `http://localhost:5173/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L122` (process.env)

### `AUTH_REFRESH_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:18` = `2592000`
- **Code references**:
  - `backend/routes/auth.js:L100` (process.env)

### `AUTH_YAHOO_CLIENT_ID`

- **Templates**:
  - `backend/env.example:81` = `yahoo-client-id`
- **Code references**: (none)

### `AUTH_YAHOO_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:82` = `yahoo-client-secret`
- **Code references**: (none)

### `BACKEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L21` (process.env)

### `BULK_POPULATE_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/crawlerV2.js:L9` (process.env)
  - `backend/routes/crawlers.js:L1240–L1758` (process.env)
  - `backend/server.js:L444–L564` (process.env)

### `CORS_ORIGIN`

- **Templates**:
  - `.env.example:5` = `http://localhost:5173`
  - `backend/.env.example:13` = `http://localhost:5173,http://127.0.0.1:5173`
  - `backend/env.example:12` = `http://localhost:5173,http://127.0.0.1:5173`
- **Code references**:
  - `backend/server.js:L79–L80` (process.env)
  - `scripts/doctor.mjs:L70` (process.env)

### `CRAWLER_MAX_SOURCES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-doctor.mjs:L134` (process.env)
  - `scripts/crawler-run.mjs:L25` (process.env)
  - `scripts/crawler-smoke.mjs:L21` (process.env)

### `CRAWLER_MAX_URLS_PER_SOURCE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L26` (process.env)
  - `scripts/crawler-smoke.mjs:L22` (process.env)

### `CRAWLER_MODE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L22` (process.env)

### `CRAWLER_STALE_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/crawlerV2.js:L38` (process.env)

### `CRAWLER_STATE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L23` (process.env)

### `CRAWLER_TIMEOUT_SECONDS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L27` (process.env)
  - `scripts/crawler-smoke.mjs:L23` (process.env)

### `CRAWLER_USE_LIVE_SOURCES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L24` (process.env)

### `DATABASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/seed-profile-grants.mjs:L18` (process.env)
  - `scripts/seed-real-opportunities.mjs:L18` (process.env)

### `DATABASE_URL`

- **Templates**:
  - `backend/.env.example:6` = `backend/data/grantflow.dev.db`
  - `backend/env.example:6` = `backend/data/grantflow.dev.db`
- **Code references**:
  - `backend/import-data.js:L26` (process.env)
  - `backend/server.js:L142` (process.env)
  - `scripts/crawler-doctor.mjs:L18` (process.env)
  - `scripts/crawler-run.mjs:L19` (process.env)
  - `scripts/crawler-smoke.mjs:L15` (process.env)
  - `tests/crawler/smoke/nationalCrawlerV2.test.js:L11` (process.env)

### `DB_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/build-seed-db.mjs:L41` (process.env)
  - `scripts/check-profiles.mjs:L42–L43` (process.env)
  - `scripts/ensure-admin-user.mjs:L24` (process.env)
  - `scripts/reattach-users-simple.mjs:L10–L11` (process.env)
  - `scripts/run-crawlers.mjs:L23–L24` (process.env)
  - `scripts/seed-profiles.mjs:L44–L45` (process.env)

### `DEV`

- **Templates**: (not present)
- **Code references**:
  - `src/api/client.js:L6` (import.meta.env)

### `FIREBASE_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L5` (process.env)

### `FIREBASE_APP_ID`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L10` (process.env)

### `FIREBASE_AUTH_DOMAIN`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L6` (process.env)

### `FIREBASE_MESSAGING_SENDER_ID`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L9` (process.env)

### `FIREBASE_PROJECT_ID`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L7` (process.env)

### `FIREBASE_STORAGE_BUCKET`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L8` (process.env)

### `FORCE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/build-seed-db.mjs:L17–L52` (process.env)

### `FROM_EMAIL`

- **Templates**:
  - `backend/.env.example:28` = `onboarding@resend.dev`
  - `backend/env.example:44` = `noreply@yourdomain.com`
- **Code references**:
  - `backend/services/email.js:L7` (process.env)

### `FRONTEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L123` (process.env)

### `GOOGLE_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L19` (process.env)

### `GOOGLE_SEARCH_CX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L20` (process.env)

### `JWT_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L37` (process.env)
  - `backend/server.js:L427–L560` (process.env)

### `LOG_LEVEL`

- **Templates**:
  - `backend/env.example:85` = `debug`
- **Code references**: (none)

### `NATIONAL_PROGRAMS_CRAWLER_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L878` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L880` (process.env)

### `NATIONAL_PROGRAMS_MAX_DEPTH`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L884` (process.env)

### `NATIONAL_PROGRAMS_MAX_URLS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L883` (process.env)

### `NODE_ENV`

- **Templates**:
  - `backend/.env.example:5` = `development`
  - `backend/env.example:5` = `development`
- **Code references**:
  - `backend/middleware/errorHandler.js:L11` (process.env)
  - `backend/routes/anya.js:L121` (process.env)
  - `backend/routes/auth.js:L1122–L1801` (process.env)
  - `backend/routes/reminders.js:L135–L154` (process.env)
  - `backend/server.js:L50–L806` (process.env)
  - `backend/services/anyaTestRepair.js:L155` (process.env)
  - `scripts/build-seed-db.mjs:L15` (process.env)
  - `scripts/seed-profiles.mjs:L28` (process.env)
  - `src/components/auth/AuthErrorBoundary.jsx:L84` (process.env)
  - `src/components/shared/ErrorBoundary.jsx:L16` (process.env)

### `OPENAI_API_KEY`

- **Templates**:
  - `backend/.env.example:22` = ``
  - `backend/env.example:37` = `sk-your-openai-key`
- **Code references**:
  - `backend/routes/admin.js:L64` (process.env)
  - `backend/routes/ai.js:L15` (process.env)
  - `backend/routes/anya.js:L53–L118` (process.env)
  - `backend/routes/auth.js:L29` (process.env)
  - `backend/routes/crawlers.js:L26` (process.env)
  - `backend/routes/profiles.js:L116` (process.env)
  - `backend/server.js:L548` (process.env)
  - `backend/services/anyaOrchestrator.js:L13` (process.env)
  - `scripts/fix-api-errors.mjs:L25–L27` (process.env)
  - `scripts/test-anya-ai.mjs:L24–L105` (process.env)
  - `scripts/test-anya-full.mjs:L97` (process.env)

### `OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/constants.js:L34` (process.env)
  - `backend/routes/admin.js:L18` (process.env)

### `PORT`

- **Templates**:
  - `.env.example:4` = `4000`
  - `backend/.env.example:4` = `8080`
  - `backend/env.example:4` = `8080`
- **Code references**:
  - `backend/server.js:L68` (process.env)

### `PUBLIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L122` (process.env)

### `REQUEST_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L94` (process.env)

### `RESEND_API_KEY`

- **Templates**:
  - `backend/.env.example:27` = ``
  - `backend/env.example:43` = `re_your-resend-key`
- **Code references**:
  - `backend/services/email.js:L6` (process.env)

### `SEED_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/seed-profiles.mjs:L51–L52` (process.env)

### `SENTRY_DSN`

- **Templates**:
  - `backend/env.example:86` = ``
- **Code references**: (none)

### `SERVICE_APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/serviceApplication.js:L7` (process.env)

### `SMOKE_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L240` (process.env)
  - `tests/smoke/smoke.spec.mjs:L10` (process.env)

### `SMOKE_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L238` (process.env)
  - `scripts/smoke-auth-callback.mjs:L49` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L51` (process.env)
  - `scripts/smoke-login.mjs:L29` (process.env)
  - `scripts/smoke-organization-profile.mjs:L51` (process.env)
  - `tests/smoke/smoke.spec.mjs:L9` (process.env)

### `SMOKE_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L20` (process.env)
  - `scripts/smoke-auth-callback.mjs:L17` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L19` (process.env)
  - `scripts/smoke-login.mjs:L16` (process.env)
  - `scripts/smoke-organization-profile.mjs:L19` (process.env)
  - `tests/smoke/playwright.config.mjs:L17` (process.env)
  - `tests/smoke/smoke.spec.mjs:L8` (process.env)

### `SMOKE_DEBUG`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-login.mjs:L58–L72` (process.env)

### `SMOKE_MODE`

- **Templates**:
  - `backend/.env.example:31` = `true`
- **Code references**: (none)

### `SMOKE_TARGET_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-login.mjs:L30` (process.env)

### `TEST_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/test-email-endpoint.mjs:L10` (process.env)

### `TWILIO_ACCOUNT_SID`

- **Templates**:
  - `backend/.env.example:24` = ``
  - `backend/env.example:30` = `ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L117` (process.env)

### `TWILIO_AUTH_TOKEN`

- **Templates**:
  - `backend/.env.example:25` = ``
  - `backend/env.example:31` = `your-twilio-auth-token`
- **Code references**:
  - `backend/routes/auth.js:L118` (process.env)

### `TWILIO_FROM_NUMBER`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L120` (process.env)

### `TWILIO_MESSAGING_SERVICE_SID`

- **Templates**:
  - `backend/.env.example:26` = ``
  - `backend/env.example:32` = `MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L119` (process.env)

### `VERIFY_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-login.mjs:L5` (process.env)

### `VERIFY_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-login.mjs:L4` (process.env)

### `VITE_API_PROXY_TARGET`

- **Templates**:
  - `.env.example:15` = `http://localhost:4000`
- **Code references**: (none)

### `VITE_API_URL`

- **Templates**:
  - `env.example:4` = `http://localhost:8080`
- **Code references**:
  - `src/api/client.js:L7` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L35–L63` (import.meta.env)

### `VITE_APP_BASE`

- **Templates**:
  - `env.example:5` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L125` (process.env)
  - `scripts/doctor.mjs:L206–L222` (process.env)
  - `src/App.jsx:L54` (import.meta.env)
  - `src/api/client.js:L9` (import.meta.env)
  - `src/components/auth/SessionExpiredDialog.jsx:L10` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L24` (import.meta.env)

### `VITE_ASSET_BASE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L207–L222` (process.env)
