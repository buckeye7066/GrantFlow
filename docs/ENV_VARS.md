# ENV Vars Inventory

This file is **generated** by `node scripts/inventory-env.mjs`.
It enumerates environment variables referenced in code and/or present in example env files.

## Summary

- Total vars: **150**
- Vars referenced in code: **141**
- Vars present in env templates: **58**

## Inventory

| Name | Referenced in code | Defined in templates | Notes |
| --- | --- | --- | --- |
| `ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `ADMIN_NAME` | Yes | Yes | Backend/Node |
| `ADMIN_PHONE` | Yes | No | Backend/Node |
| `ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ALLOW_MOCK_AI` | Yes | No | Backend/Node |
| `ANALYTICS_WRITE_KEY` | No | Yes |  |
| `ANTHROPIC_API_KEY` | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ANYA_API_KEY` | Yes | No | Backend/Node |
| `ANYA_AUTONOMOUS_ENABLED` | Yes | Yes | Backend/Node |
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
| `AUTH_NOTIFY_EMAIL` | Yes | No | Backend/Node |
| `AUTH_NOTIFY_ON_LOGIN` | Yes | No | Backend/Node |
| `AUTH_OAUTH_STATE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_CODE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_RATE_LIMIT` | Yes | No | Backend/Node |
| `AUTH_PHONE_RESEND_SECONDS` | Yes | Yes | Backend/Node |
| `AUTH_PUBLIC_URL` | Yes | Yes | Backend/Node |
| `AUTH_REFRESH_TOKEN_TTL` | Yes | Yes | Backend/Node |
| `AUTH_YAHOO_CLIENT_ID` | No | Yes |  |
| `AUTH_YAHOO_CLIENT_SECRET` | No | Yes |  |
| `BACKEND_BASE_URL` | Yes | No | Backend/Node |
| `BASE_URL` | Yes | No | Used in both backend + frontend |
| `BUILD_TIMESTAMP` | Yes | No | Backend/Node |
| `BULK_POPULATE_KEY` | Yes | No | Backend/Node |
| `COMMIT_SHA` | Yes | No | Backend/Node |
| `CONFIRM` | Yes | No | Backend/Node |
| `CORS_ORIGIN` | Yes | Yes | Backend/Node |
| `CRAWLER_MAX_SOURCES` | Yes | No | Backend/Node |
| `CRAWLER_MAX_URLS_PER_SOURCE` | Yes | No | Backend/Node |
| `CRAWLER_MODE` | Yes | No | Backend/Node |
| `CRAWLER_STALE_DAYS` | Yes | No | Backend/Node |
| `CRAWLER_STATE` | Yes | No | Backend/Node |
| `CRAWLER_TIMEOUT_SECONDS` | Yes | No | Backend/Node |
| `CRAWLER_USE_LIVE_SOURCES` | Yes | No | Backend/Node |
| `DATABASE_PATH` | Yes | No | Backend/Node |
| `DATABASE_PUBLIC_URL` | Yes | No | Backend/Node |
| `DATABASE_URL` | Yes | No | Backend/Node |
| `DB_AUTO_MIGRATE` | Yes | Yes | Backend/Node |
| `DB_DIALECT` | Yes | No | Backend/Node |
| `DB_PATH` | Yes | No | Backend/Node |
| `DB_PROVIDER` | Yes | Yes | Backend/Node |
| `DEV` | Yes | No | Frontend (Vite) |
| `ENABLE_MIN_NATIONAL_ENSURE` | Yes | No | Backend/Node |
| `FEATURE_ANYA_TOOLS` | Yes | No | Backend/Node |
| `FEATURE_AUTO_REPAIR` | Yes | No | Backend/Node |
| `FEATURE_CRAWLER_RETRIES` | Yes | No | Backend/Node |
| `FEATURE_DETAILED_MATCHING` | Yes | No | Backend/Node |
| `FEATURE_GEO_CRAWL` | Yes | No | Backend/Node |
| `FORCE` | Yes | No | Backend/Node |
| `FROM_EMAIL` | Yes | Yes | Backend/Node |
| `FRONTEND_BASE_URL` | Yes | No | Backend/Node |
| `GEO_COUNTIES_BY_STATE_PATH` | Yes | Yes | Backend/Node |
| `GEO_ZIP_COORDINATES_PATH` | Yes | Yes | Backend/Node |
| `GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `GOOGLE_API_KEY` | Yes | No | Backend/Node |
| `GOOGLE_SEARCH_CX` | Yes | No | Backend/Node |
| `JWT_SECRET` | Yes | No | Backend/Node |
| `LIMIT` | Yes | No | Backend/Node |
| `LIVE_CRAWL_PERSIST_OPPS` | Yes | No | Backend/Node |
| `LIVE_CRAWL_TIMEOUT_MS` | Yes | No | Backend/Node |
| `LOG_LEVEL` | No | Yes |  |
| `MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK` | Yes | No | Backend/Node |
| `MIN_NATIONAL_OPPORTUNITIES` | Yes | No | Backend/Node |
| `MIN_NATIONAL_VISIBLE` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_ENABLED` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_DEPTH` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_URLS` | Yes | No | Backend/Node |
| `NODE_ENV` | Yes | Yes | Backend/Node |
| `OPENAI_API_KEY` | Yes | Yes | Backend/Node |
| `OPENAI_MODEL` | Yes | No | Backend/Node |
| `PG_POOL_CONN_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PG_POOL_IDLE_MS` | Yes | No | Backend/Node |
| `PG_POOL_MAX` | Yes | No | Backend/Node |
| `PORT` | Yes | Yes | Backend/Node |
| `PROD` | Yes | No | Frontend (Vite) |
| `PUBLIC_URL` | Yes | No | Backend/Node |
| `RAILWAY_DEPLOYMENT_START_TIME` | Yes | No | Backend/Node |
| `RAILWAY_GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `REQUEST_TIMEOUT_MS` | Yes | No | Backend/Node |
| `RESEND_API_KEY` | Yes | Yes | Backend/Node |
| `RUNTIME_SECRETS_KEY` | Yes | No | Backend/Node |
| `SAM_GOV_API_KEY` | Yes | No | Backend/Node |
| `SEED_KEY` | Yes | No | Backend/Node |
| `SEED_PATH` | Yes | No | Backend/Node |
| `SENTRY_DSN` | No | Yes |  |
| `SERVICE_APPLICATION_EMAIL` | Yes | No | Backend/Node |
| `SESSION_SECRET` | Yes | No | Backend/Node |
| `SMOKE_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `SMOKE_BASE_PATH` | Yes | No | Backend/Node |
| `SMOKE_BASE_URL` | Yes | No | Backend/Node |
| `SMOKE_DEBUG` | Yes | No | Backend/Node |
| `SMOKE_MAX_CLICKS` | Yes | No | Backend/Node |
| `SMOKE_MAX_PER_SELECTOR` | Yes | No | Backend/Node |
| `SMOKE_MAX_ROUTES` | Yes | No | Backend/Node |
| `SMOKE_TARGET_PATH` | Yes | No | Backend/Node |
| `SOURCE` | Yes | No | Backend/Node |
| `SQLITE_DB_PATH` | Yes | Yes | Backend/Node |
| `TEST_STATE` | Yes | No | Backend/Node |
| `TWILIO_ACCOUNT_SID` | Yes | Yes | Backend/Node |
| `TWILIO_AUTH_TOKEN` | Yes | Yes | Backend/Node |
| `TWILIO_FROM_NUMBER` | Yes | No | Backend/Node |
| `TWILIO_MESSAGING_SERVICE_SID` | Yes | Yes | Backend/Node |
| `UPLOADS_DIR` | Yes | Yes | Backend/Node |
| `VERCEL_GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `VERIFY_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `VERIFY_BASE_URL` | Yes | No | Backend/Node |
| `VITE_API_URL` | Yes | Yes | Frontend (Vite) |
| `VITE_APP_BASE` | Yes | Yes | Used in both backend + frontend |
| `VITE_ASSET_BASE` | Yes | No | Backend/Node |
| `VITE_CANONICAL_HOST` | Yes | No | Frontend (Vite) |
| `VITE_CANONICAL_HOST_STRICT` | Yes | No | Frontend (Vite) |
| `VITE_DEV_ADMIN_TOKEN` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_API_KEY` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_APP_ID` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_PROJECT_ID` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_STORAGE_BUCKET` | Yes | No | Frontend (Vite) |

## Usage locations (file + line ranges)

### `ADMIN_EMAIL`

- **Templates**:
  - `backend/env.example:21` = `admin@grantflow.local`
- **Code references**:
  - `backend/config/constants.js:L8` (process.env)
  - `backend/server.js:L70` (process.env)
  - `backend/services/anyaOrchestrator.js:L11` (process.env)
  - `backend/services/email.js:L8` (process.env)
  - `scripts/ensure-admin-user.mjs:L19` (process.env)

### `ADMIN_NAME`

- **Templates**:
  - `backend/env.example:20` = `Local Admin`
- **Code references**:
  - `backend/server.js:L69` (process.env)
  - `scripts/ensure-admin-user.mjs:L21` (process.env)

### `ADMIN_PHONE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/ensure-admin-user.mjs:L20` (process.env)

### `ADMIN_TOKEN`

- **Templates**:
  - `backend/env.example:19` = `dev-admin-token`
- **Code references**:
  - `backend/routes/anya.js:L19` (process.env)
  - `backend/server.js:L68–L874` (process.env)
  - `scripts/diagnose-anya.mjs:L20` (process.env)
  - `scripts/doctor.mjs:L70` (process.env)
  - `scripts/run-all-real-crawlers.mjs:L5` (process.env)

### `ALLOW_MOCK_AI`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/mockAI.js:L9` (process.env)

### `ANALYTICS_WRITE_KEY`

- **Templates**:
  - `backend/env.example:112` = ``
- **Code references**: (none)

### `ANTHROPIC_API_KEY`

- **Templates**:
  - `backend/env.example:65` = `sk-ant-your-anthropic-key`
- **Code references**:
  - `backend/routes/anya.js:L52–L111` (process.env)
  - `backend/services/diagnosticsService.js:L186` (process.env)
  - `scripts/diagnose-anya.mjs:L26–L40` (process.env)

### `ANYA_ADMIN_TOKEN`

- **Templates**:
  - `backend/env.example:29` = `anya-dev-token`
- **Code references**:
  - `backend/routes/anya.js:L19` (process.env)
  - `backend/server.js:L68–L874` (process.env)
  - `backend/services/diagnosticsService.js:L191` (process.env)
  - `scripts/diagnose-anya.mjs:L20` (process.env)

### `ANYA_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L737–L737` (process.env)

### `ANYA_AUTONOMOUS_ENABLED`

- **Templates**:
  - `backend/env.example:74` = `false`
- **Code references**:
  - `backend/server.js:L1293` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L15` (process.env)
  - `scripts/check-anya-status.mjs:L23–L107` (process.env)

### `ANYA_CODE_CRAWL`

- **Templates**:
  - `backend/env.example:83` = `true              # Scan and fix code issues`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L24` (process.env)

### `ANYA_CRAWLERS`

- **Templates**:
  - `backend/env.example:85` = `true                # Run grant crawlers`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L26` (process.env)

### `ANYA_DRY_RUN`

- **Templates**:
  - `backend/env.example:99` = `false                # Dry run mode (no actual changes)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L38–L47` (process.env)

### `ANYA_FIX_CONSOLE`

- **Templates**:
  - `backend/env.example:88` = `true             # Fix console.log statements`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L35` (process.env)

### `ANYA_FIX_EMPTY_CATCH`

- **Templates**:
  - `backend/env.example:89` = `true         # Fix empty catch blocks`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L36` (process.env)

### `ANYA_FIX_ERRORS`

- **Templates**:
  - `backend/env.example:98` = `false             # Auto-fix found errors`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L46` (process.env)

### `ANYA_FUNCTION_TESTS`

- **Templates**:
  - `backend/env.example:84` = `true          # Test API endpoints`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L25` (process.env)

### `ANYA_MATCH_THRESHOLD`

- **Templates**:
  - `backend/env.example:93` = `80           # Min % match to save to profile (0-100)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L41` (process.env)

### `ANYA_MAX_FILE_CHANGES`

- **Templates**:
  - `backend/env.example:90` = `20          # Max files to modify per run`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L37` (process.env)

### `ANYA_OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L34` (process.env)

### `ANYA_RUN_ON_ADMIN_LOGIN`

- **Templates**:
  - `backend/env.example:78` = `false    # Run when admin logs in`
- **Code references**:
  - `backend/routes/auth.js:L1580` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L19` (process.env)

### `ANYA_RUN_ON_SCHEDULE`

- **Templates**:
  - `backend/env.example:79` = `false       # Run on schedule (cron)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L20` (process.env)

### `ANYA_RUN_ON_STARTUP`

- **Templates**:
  - `backend/env.example:77` = `false        # Run when server starts`
- **Code references**:
  - `backend/server.js:L1295` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L18` (process.env)
  - `scripts/check-anya-status.mjs:L24` (process.env)

### `ANYA_SAVE_GLOBAL`

- **Templates**:
  - `backend/env.example:94` = `true             # Save all opportunities globally`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L42` (process.env)

### `ANYA_SCHEDULE`

- **Templates**:
  - `backend/env.example:80` = `0 3 * * *           # Cron schedule (default: 3 AM daily)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L30` (process.env)

### `ANYA_WAIT_COMPLETION`

- **Templates**:
  - `backend/env.example:95` = `false        # Wait for crawlers to complete`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L43` (process.env)

### `API_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-auth-diagnostics.mjs:L12` (process.env)

### `API_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/diagnose-anya.mjs:L19` (process.env)

### `APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/profiles.js:L1071` (process.env)

### `APP_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L154` (process.env)

### `AUTH_ACCESS_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:42` = `10800`
- **Code references**:
  - `backend/routes/auth.js:L128` (process.env)

### `AUTH_EMAIL_CODE_TTL`

- **Templates**:
  - `backend/env.example:44` = `600`
- **Code references**:
  - `backend/routes/auth.js:L130` (process.env)

### `AUTH_EMAIL_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L198` (process.env)

### `AUTH_EMAIL_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:45` = `45`
- **Code references**:
  - `backend/routes/auth.js:L131` (process.env)

### `AUTH_FACEBOOK_CLIENT_ID`

- **Templates**:
  - `backend/env.example:104` = `facebook-client-id`
- **Code references**: (none)

### `AUTH_FACEBOOK_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:105` = `facebook-client-secret`
- **Code references**: (none)

### `AUTH_FRONTEND_APP_BASE`

- **Templates**:
  - `backend/env.example:52` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L154` (process.env)
  - `backend/server.js:L253` (process.env)

### `AUTH_FRONTEND_URL`

- **Templates**:
  - `backend/env.example:51` = `http://localhost:5173`
- **Code references**:
  - `backend/routes/auth.js:L152` (process.env)
  - `backend/services/diagnosticsService.js:L195` (process.env)

### `AUTH_GOOGLE_CLIENT_ID`

- **Templates**:
  - `backend/env.example:102` = `google-client-id`
- **Code references**: (none)

### `AUTH_GOOGLE_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:103` = `google-client-secret`
- **Code references**: (none)

### `AUTH_JWT_SECRET`

- **Templates**:
  - `backend/env.example:41` = `dev-secret-change-me`
- **Code references**:
  - `backend/routes/auth.js:L39` (process.env)
  - `backend/server.js:L685–L871` (process.env)
  - `backend/utils/runtimeSecrets.js:L19` (process.env)

### `AUTH_NOTIFY_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L190` (process.env)
  - `backend/services/email.js:L9` (process.env)

### `AUTH_NOTIFY_ON_LOGIN`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L189` (process.env)
  - `backend/services/email.js:L10` (process.env)

### `AUTH_OAUTH_STATE_TTL`

- **Templates**:
  - `backend/env.example:48` = `600`
- **Code references**:
  - `backend/routes/auth.js:L134` (process.env)

### `AUTH_PHONE_CODE_TTL`

- **Templates**:
  - `backend/env.example:46` = `600`
- **Code references**:
  - `backend/routes/auth.js:L132` (process.env)

### `AUTH_PHONE_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L205` (process.env)

### `AUTH_PHONE_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:47` = `60`
- **Code references**:
  - `backend/routes/auth.js:L133` (process.env)

### `AUTH_PUBLIC_URL`

- **Templates**:
  - `backend/env.example:50` = `http://localhost:5173/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L151` (process.env)
  - `backend/services/diagnosticsService.js:L194` (process.env)

### `AUTH_REFRESH_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:43` = `2592000`
- **Code references**:
  - `backend/routes/auth.js:L129` (process.env)

### `AUTH_YAHOO_CLIENT_ID`

- **Templates**:
  - `backend/env.example:106` = `yahoo-client-id`
- **Code references**: (none)

### `AUTH_YAHOO_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:107` = `yahoo-client-secret`
- **Code references**: (none)

### `BACKEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L21` (process.env)

### `BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-all-real-crawlers.mjs:L4` (process.env)
  - `src/App.jsx:L73` (import.meta.env)

### `BUILD_TIMESTAMP`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1051` (process.env)

### `BULK_POPULATE_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/crawlerV2.js:L9` (process.env)
  - `backend/routes/crawlers.js:L1276–L1981` (process.env)
  - `backend/server.js:L729–L875` (process.env)

### `COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1040` (process.env)

### `CONFIRM`

- **Templates**: (not present)
- **Code references**:
  - `scripts/godaddy-set-vercel-dns.mjs:L93` (process.env)

### `CORS_ORIGIN`

- **Templates**:
  - `backend/env.example:28` = `http://localhost:5173,http://127.0.0.1:5173`
- **Code references**:
  - `backend/server.js:L94–L95` (process.env)
  - `scripts/doctor.mjs:L71` (process.env)

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
  - `backend/db/migrations/run-migration.js:L15` (process.env)
  - `scripts/fix-malformed-json.mjs:L20` (process.env)
  - `scripts/ingest-grantsgov.mjs:L17` (process.env)
  - `scripts/ingest-usaspending.mjs:L17` (process.env)
  - `scripts/ingest.mjs:L18` (process.env)
  - `scripts/seed-profile-grants.mjs:L18` (process.env)
  - `scripts/seed-real-opportunities.mjs:L18` (process.env)

### `DATABASE_PUBLIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L314` (process.env)

### `DATABASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L30–L331` (process.env)
  - `backend/import-data.js:L24` (process.env)
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L314` (process.env)
  - `scripts/crawler-doctor.mjs:L18` (process.env)
  - `scripts/crawler-run.mjs:L19` (process.env)
  - `scripts/crawler-smoke.mjs:L15` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L20` (process.env)

### `DB_AUTO_MIGRATE`

- **Templates**:
  - `backend/env.example:17` = `false`
- **Code references**:
  - `backend/server.js:L284` (process.env)

### `DB_DIALECT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L27` (process.env)

### `DB_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L1703` (process.env)
  - `backend/services/diagnosticsService.js:L63–L193` (process.env)
  - `backend/tests/crawlerMatrixTest.js:L26` (process.env)
  - `scripts/build-seed-db.mjs:L41` (process.env)
  - `scripts/check-profiles.mjs:L42–L43` (process.env)
  - `scripts/db-opportunity-tag-stats.cjs:L3` (process.env)
  - `scripts/db-term-coverage.cjs:L3` (process.env)
  - `scripts/db-top-tags.cjs:L3` (process.env)
  - `scripts/db-url-stats.cjs:L3` (process.env)
  - `scripts/ensure-admin-user.mjs:L24` (process.env)
  - `scripts/reattach-users-simple.mjs:L10–L11` (process.env)
  - `scripts/run-crawlers.mjs:L23–L24` (process.env)
  - `scripts/seed-profiles.mjs:L44–L45` (process.env)

### `DB_PROVIDER`

- **Templates**:
  - `backend/env.example:9` = `sqlite`
- **Code references**:
  - `backend/db/index.js:L26` (process.env)

### `DEV`

- **Templates**: (not present)
- **Code references**:
  - `src/api/auth.js:L4–L11` (import.meta.env)
  - `src/api/client.js:L9–L15` (import.meta.env)
  - `src/components/auth/AuthErrorBoundary.jsx:L84` (import.meta.env)
  - `src/components/shared/ErrorBoundary.jsx:L16` (import.meta.env)

### `ENABLE_MIN_NATIONAL_ENSURE`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L599` (process.env)

### `FEATURE_ANYA_TOOLS`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/features.js:L8` (process.env)

### `FEATURE_AUTO_REPAIR`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/features.js:L9` (process.env)

### `FEATURE_CRAWLER_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/features.js:L11` (process.env)

### `FEATURE_DETAILED_MATCHING`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/features.js:L10` (process.env)

### `FEATURE_GEO_CRAWL`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/features.js:L7` (process.env)

### `FORCE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/build-seed-db.mjs:L17–L52` (process.env)

### `FROM_EMAIL`

- **Templates**:
  - `backend/env.example:69` = `noreply@yourdomain.com`
- **Code references**:
  - `backend/services/diagnosticsService.js:L188` (process.env)
  - `backend/services/email.js:L7` (process.env)

### `FRONTEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L152` (process.env)
  - `backend/services/diagnosticsService.js:L195` (process.env)

### `GEO_COUNTIES_BY_STATE_PATH`

- **Templates**:
  - `backend/env.example:37` = ``
- **Code references**:
  - `backend/routes/admin.js:L46–L47` (process.env)

### `GEO_ZIP_COORDINATES_PATH`

- **Templates**:
  - `backend/env.example:36` = ``
- **Code references**:
  - `backend/routes/admin.js:L43–L44` (process.env)

### `GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1039` (process.env)

### `GOOGLE_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L70` (process.env)

### `GOOGLE_SEARCH_CX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L71` (process.env)

### `JWT_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L39` (process.env)
  - `backend/server.js:L685–L871` (process.env)
  - `backend/utils/runtimeSecrets.js:L20` (process.env)

### `LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `scripts/db-top-tags.cjs:L5` (process.env)

### `LIVE_CRAWL_PERSIST_OPPS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/realCrawlers.js:L34` (process.env)

### `LIVE_CRAWL_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/realCrawlers.js:L32` (process.env)

### `LOG_LEVEL`

- **Templates**:
  - `backend/env.example:110` = `debug`
- **Code references**: (none)

### `MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/realCrawlers.js:L33` (process.env)

### `MIN_NATIONAL_OPPORTUNITIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L595` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L132` (process.env)

### `MIN_NATIONAL_VISIBLE`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L245` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L79` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1315` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1317` (process.env)

### `NATIONAL_PROGRAMS_MAX_DEPTH`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1321` (process.env)

### `NATIONAL_PROGRAMS_MAX_URLS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1320` (process.env)

### `NODE_ENV`

- **Templates**:
  - `backend/env.example:5` = `development`
- **Code references**:
  - `backend/middleware/errorHandler.js:L11` (process.env)
  - `backend/routes/anya.js:L121` (process.env)
  - `backend/routes/auth.js:L40–L2038` (process.env)
  - `backend/routes/reminders.js:L157–L176` (process.env)
  - `backend/server.js:L61–L1282` (process.env)
  - `backend/services/anyaTestRepair.js:L155` (process.env)
  - `backend/services/diagnosticsService.js:L30–L192` (process.env)
  - `backend/services/mockAI.js:L9` (process.env)
  - `scripts/build-seed-db.mjs:L15` (process.env)
  - `scripts/seed-profiles.mjs:L28` (process.env)

### `OPENAI_API_KEY`

- **Templates**:
  - `backend/env.example:62` = `sk-your-openai-key`
- **Code references**:
  - `backend/routes/admin.js:L342–L434` (process.env)
  - `backend/routes/anya.js:L53–L118` (process.env)
  - `backend/routes/auth.js:L30` (process.env)
  - `backend/routes/crawlers.js:L38` (process.env)
  - `backend/scripts/create-profile-from-pdf.mjs:L74` (process.env)
  - `backend/scripts/dispatch-crawlers.mjs:L12` (process.env)
  - `backend/scripts/fix-anastasia-profile.mjs:L9` (process.env)
  - `backend/scripts/process-all-jobs.mjs:L10` (process.env)
  - `backend/scripts/process-queue.mjs:L11` (process.env)
  - `backend/server.js:L306–L859` (process.env)
  - `backend/services/anyaOrchestrator.js:L18` (process.env)
  - `backend/services/anyaToolRegistry.js:L752` (process.env)
  - `backend/services/diagnosticsService.js:L185` (process.env)
  - `backend/utils/openaiClient.js:L29–L50` (process.env)
  - `scripts/fix-api-errors.mjs:L25–L27` (process.env)

### `OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/constants.js:L34` (process.env)
  - `backend/routes/admin.js:L33` (process.env)
  - `backend/routes/profiles.js:L763` (process.env)

### `PG_POOL_CONN_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L252` (process.env)

### `PG_POOL_IDLE_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L251` (process.env)

### `PG_POOL_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L250` (process.env)

### `PORT`

- **Templates**:
  - `backend/env.example:4` = `8080`
- **Code references**:
  - `backend/server.js:L83` (process.env)

### `PROD`

- **Templates**: (not present)
- **Code references**:
  - `src/utils/enforceCanonicalHost.js:L4` (import.meta.env)

### `PUBLIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L151` (process.env)
  - `backend/services/diagnosticsService.js:L194` (process.env)

### `RAILWAY_DEPLOYMENT_START_TIME`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1052` (process.env)

### `RAILWAY_GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1038` (process.env)

### `REQUEST_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L152` (process.env)

### `RESEND_API_KEY`

- **Templates**:
  - `backend/env.example:68` = `re_your-resend-key`
- **Code references**:
  - `backend/services/diagnosticsService.js:L187` (process.env)
  - `backend/services/email.js:L6` (process.env)

### `RUNTIME_SECRETS_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/runtimeSecrets.js:L4` (process.env)

### `SAM_GOV_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaToolRegistry.js:L753` (process.env)
  - `backend/services/connectors/samGovConnector.js:L61–L118` (process.env)
  - `backend/services/diagnosticsService.js:L184` (process.env)

### `SEED_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L1216` (process.env)

### `SEED_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/seed-profiles.mjs:L51–L52` (process.env)

### `SENTRY_DSN`

- **Templates**:
  - `backend/env.example:111` = ``
- **Code references**: (none)

### `SERVICE_APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/serviceApplication.js:L8` (process.env)

### `SESSION_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/runtimeSecrets.js:L21` (process.env)

### `SMOKE_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L172` (process.env)

### `SMOKE_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L170` (process.env)
  - `scripts/smoke-auth-callback.mjs:L49` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L51` (process.env)
  - `scripts/smoke-login.mjs:L29` (process.env)
  - `scripts/smoke-organization-profile.mjs:L51` (process.env)

### `SMOKE_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L20` (process.env)
  - `scripts/smoke-auth-callback.mjs:L17` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L19` (process.env)
  - `scripts/smoke-login.mjs:L16` (process.env)
  - `scripts/smoke-organization-profile.mjs:L19` (process.env)

### `SMOKE_DEBUG`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-login.mjs:L58–L72` (process.env)

### `SMOKE_MAX_CLICKS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L176` (process.env)

### `SMOKE_MAX_PER_SELECTOR`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L177` (process.env)

### `SMOKE_MAX_ROUTES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L175` (process.env)

### `SMOKE_TARGET_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-login.mjs:L30` (process.env)

### `SOURCE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/db-top-tags.cjs:L4` (process.env)

### `SQLITE_DB_PATH`

- **Templates**:
  - `backend/env.example:10` = `backend/data/grantflow.dev.db`
- **Code references**:
  - `backend/db/index.js:L345` (process.env)
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L312` (process.env)

### `TEST_STATE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/opportunities-national-minimum.mjs:L133` (process.env)

### `TWILIO_ACCOUNT_SID`

- **Templates**:
  - `backend/env.example:55` = `ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L146` (process.env)
  - `backend/services/diagnosticsService.js:L196` (process.env)

### `TWILIO_AUTH_TOKEN`

- **Templates**:
  - `backend/env.example:56` = `your-twilio-auth-token`
- **Code references**:
  - `backend/routes/auth.js:L147` (process.env)
  - `backend/services/diagnosticsService.js:L196` (process.env)

### `TWILIO_FROM_NUMBER`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L149` (process.env)

### `TWILIO_MESSAGING_SERVICE_SID`

- **Templates**:
  - `backend/env.example:57` = `MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L148` (process.env)

### `UPLOADS_DIR`

- **Templates**:
  - `backend/env.example:26` = ``
- **Code references**:
  - `backend/routes/admin.js:L38–L39` (process.env)
  - `backend/routes/profiles.js:L35–L36` (process.env)
  - `backend/server.js:L76–L77` (process.env)
  - `tests/unit/release-hardening.test.mjs:L30–L31` (process.env)

### `VERCEL_GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1041` (process.env)

### `VERIFY_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-login.mjs:L5` (process.env)

### `VERIFY_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-login.mjs:L4` (process.env)

### `VITE_API_URL`

- **Templates**:
  - `env.example:4` = `http://localhost:8080`
- **Code references**:
  - `src/api/client.js:L10–L20` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L35–L63` (import.meta.env)

### `VITE_APP_BASE`

- **Templates**:
  - `env.example:5` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L154` (process.env)
  - `backend/server.js:L253` (process.env)
  - `scripts/doctor.mjs:L72–L170` (process.env)
  - `src/App.jsx:L73` (import.meta.env)
  - `src/api/client.js:L12` (import.meta.env)
  - `src/components/auth/SessionExpiredDialog.jsx:L10` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L24` (import.meta.env)

### `VITE_ASSET_BASE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L159` (process.env)

### `VITE_CANONICAL_HOST`

- **Templates**: (not present)
- **Code references**:
  - `src/utils/enforceCanonicalHost.js:L6` (import.meta.env)

### `VITE_CANONICAL_HOST_STRICT`

- **Templates**: (not present)
- **Code references**:
  - `src/utils/enforceCanonicalHost.js:L11` (import.meta.env)

### `VITE_DEV_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `src/pages/Login.jsx:L71` (import.meta.env)

### `VITE_FIREBASE_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L5` (import.meta.env)

### `VITE_FIREBASE_APP_ID`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L10` (import.meta.env)

### `VITE_FIREBASE_AUTH_DOMAIN`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L6` (import.meta.env)

### `VITE_FIREBASE_MESSAGING_SENDER_ID`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L9` (import.meta.env)

### `VITE_FIREBASE_PROJECT_ID`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L7` (import.meta.env)

### `VITE_FIREBASE_STORAGE_BUCKET`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:L8` (import.meta.env)
