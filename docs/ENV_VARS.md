# ENV Vars Inventory

This file is **generated** by `node scripts/inventory-env.mjs`.
It enumerates environment variables referenced in code and/or present in example env files.

## Summary

- Total vars: **127**
- Vars referenced in code: **118**
- Vars present in env templates: **56**

## Inventory

| Name | Required? | Default / dev value | Referenced in code | Defined in templates | Notes |
| --- | --- | --- | --- | --- | --- |
| `ADMIN_EMAIL` | Optional | admin@grantflow.local | Yes | Yes | Backend/Node |
| `ADMIN_NAME` | Optional | Local Admin | Yes | Yes | Backend/Node |
| `ADMIN_PHONE` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `ADMIN_TOKEN` | Optional (feature-gated) | dev-admin-token | Yes | Yes | Backend/Node |
| `ALLOW_MOCK_AI` | Optional |  | Yes | No | Backend/Node |
| `ANALYTICS_WRITE_KEY` | Optional (feature-gated) |  | No | Yes |  |
| `ANTHROPIC_API_KEY` | Optional (feature-gated) |  | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_EMAIL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `ANYA_ADMIN_TOKEN` | Optional (feature-gated) | anya-dev-token | Yes | Yes | Backend/Node |
| `ANYA_API_KEY` | Optional (feature-gated) |  | Yes | No | Backend/Node |
| `ANYA_AUTONOMOUS_ENABLED` | Optional | false | Yes | Yes | Backend/Node |
| `ANYA_CODE_CRAWL` | Optional | true              # Scan and fix code issues | Yes | Yes | Backend/Node |
| `ANYA_CRAWLERS` | Optional | true                # Run grant crawlers | Yes | Yes | Backend/Node |
| `ANYA_DRY_RUN` | Optional | false                # Dry run mode (no actual changes) | Yes | Yes | Backend/Node |
| `ANYA_FIX_CONSOLE` | Optional | true             # Fix console.log statements | Yes | Yes | Backend/Node |
| `ANYA_FIX_EMPTY_CATCH` | Optional | true         # Fix empty catch blocks | Yes | Yes | Backend/Node |
| `ANYA_FIX_ERRORS` | Optional | false             # Auto-fix found errors | Yes | Yes | Backend/Node |
| `ANYA_FUNCTION_TESTS` | Optional | true          # Test API endpoints | Yes | Yes | Backend/Node |
| `ANYA_MATCH_THRESHOLD` | Optional | 80           # Min % match to save to profile (0-100) | Yes | Yes | Backend/Node |
| `ANYA_MAX_FILE_CHANGES` | Optional | 20          # Max files to modify per run | Yes | Yes | Backend/Node |
| `ANYA_OPENAI_MODEL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `ANYA_RUN_ON_ADMIN_LOGIN` | Optional | false    # Run when admin logs in | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_SCHEDULE` | Optional | false       # Run on schedule (cron) | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_STARTUP` | Optional | false        # Run when server starts | Yes | Yes | Backend/Node |
| `ANYA_SAVE_GLOBAL` | Optional | true             # Save all opportunities globally | Yes | Yes | Backend/Node |
| `ANYA_SCHEDULE` | Optional | 0 3 * * *           # Cron schedule (default: 3 AM daily) | Yes | Yes | Backend/Node |
| `ANYA_WAIT_COMPLETION` | Optional | false        # Wait for crawlers to complete | Yes | Yes | Backend/Node |
| `API_BASE_URL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `API_URL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `APPLICATION_EMAIL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `APP_BASE_PATH` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `ARTIFACTS_DIR` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `AUTH_ACCESS_TOKEN_TTL` | Optional | 10800 | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_CODE_TTL` | Optional | 600 | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_RATE_LIMIT` | Optional |  | Yes | No | Backend/Node |
| `AUTH_EMAIL_RESEND_SECONDS` | Optional | 45 | Yes | Yes | Backend/Node |
| `AUTH_FACEBOOK_CLIENT_ID` | Optional | facebook-client-id | No | Yes |  |
| `AUTH_FACEBOOK_CLIENT_SECRET` | Optional (feature-gated) | facebook-client-secret | No | Yes |  |
| `AUTH_FRONTEND_APP_BASE` | Optional | /grantflow | Yes | Yes | Backend/Node |
| `AUTH_FRONTEND_URL` | Optional | http://localhost:5173 | Yes | Yes | Backend/Node |
| `AUTH_GOOGLE_CLIENT_ID` | Optional | google-client-id | No | Yes |  |
| `AUTH_GOOGLE_CLIENT_SECRET` | Optional (feature-gated) | google-client-secret | No | Yes |  |
| `AUTH_JWT_SECRET` | Required (prod) | dev-secret-change-me | Yes | Yes | Backend/Node |
| `AUTH_OAUTH_STATE_TTL` | Optional | 600 | Yes | Yes | Backend/Node |
| `AUTH_PHONE_CODE_TTL` | Optional | 600 | Yes | Yes | Backend/Node |
| `AUTH_PHONE_RATE_LIMIT` | Optional |  | Yes | No | Backend/Node |
| `AUTH_PHONE_RESEND_SECONDS` | Optional | 60 | Yes | Yes | Backend/Node |
| `AUTH_PUBLIC_URL` | Optional | http://localhost:5173/grantflow | Yes | Yes | Backend/Node |
| `AUTH_REFRESH_TOKEN_TTL` | Optional | 2592000 | Yes | Yes | Backend/Node |
| `AUTH_YAHOO_CLIENT_ID` | Optional | yahoo-client-id | No | Yes |  |
| `AUTH_YAHOO_CLIENT_SECRET` | Optional (feature-gated) | yahoo-client-secret | No | Yes |  |
| `BACKEND_BASE_URL` | Optional |  | Yes | No | Backend/Node |
| `BASE_URL` | Optional | (has code fallback) | Yes | No | Used in both backend + frontend |
| `BULK_POPULATE_KEY` | Optional (feature-gated) | grantflow-bulk-2026 | Yes | Yes | Backend/Node |
| `CORS_ORIGIN` | Optional | http://localhost:5173,http://127.0.0.1:5173 | Yes | Yes | Backend/Node |
| `CRAWLER_MAX_SOURCES` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `CRAWLER_MAX_URLS_PER_SOURCE` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `CRAWLER_MODE` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `CRAWLER_STALE_DAYS` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `CRAWLER_STATE` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `CRAWLER_TIMEOUT_SECONDS` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `CRAWLER_USE_LIVE_SOURCES` | Optional |  | Yes | No | Backend/Node |
| `DATABASE_PATH` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `DATABASE_URL` | Required (local-run) | backend/data/grantflow.dev.db | Yes | Yes | Backend/Node |
| `DB_PATH` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `DEV` | Optional |  | Yes | No | Frontend (Vite) |
| `ENABLE_MIN_NATIONAL_ENSURE` | Optional |  | Yes | No | Backend/Node |
| `FIREBASE_API_KEY` | Optional (feature-gated) |  | Yes | No | Backend/Node |
| `FIREBASE_APP_ID` | Optional |  | Yes | No | Backend/Node |
| `FIREBASE_AUTH_DOMAIN` | Optional |  | Yes | No | Backend/Node |
| `FIREBASE_MESSAGING_SENDER_ID` | Optional |  | Yes | No | Backend/Node |
| `FIREBASE_PROJECT_ID` | Optional |  | Yes | No | Backend/Node |
| `FIREBASE_STORAGE_BUCKET` | Optional |  | Yes | No | Backend/Node |
| `FORCE` | Optional |  | Yes | No | Backend/Node |
| `FROM_EMAIL` | Optional | noreply@grantflow.local | Yes | Yes | Backend/Node |
| `FRONTEND_BASE_URL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `GOOGLE_API_KEY` | Optional (feature-gated) | (has code fallback) | Yes | No | Backend/Node |
| `GOOGLE_SEARCH_CX` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `ITEM_REQUEST` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `JWT_SECRET` | Optional (feature-gated) | (has code fallback) | Yes | No | Backend/Node |
| `LOG_LEVEL` | Optional | debug | No | Yes |  |
| `MIN_NATIONAL_OPPORTUNITIES` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `MIN_NATIONAL_VISIBLE` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_ENABLED` | Optional |  | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_DEPTH` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_URLS` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `NODE_ENV` | Optional | development | Yes | Yes | Backend/Node |
| `OPENAI_API_KEY` | Required (prod) | (has code fallback) | Yes | Yes | Backend/Node |
| `OPENAI_MODEL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `PORT` | Optional | 8080 | Yes | Yes | Backend/Node |
| `PUBLIC_URL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `REQUEST_TIMEOUT_MS` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `RESEND_API_KEY` | Optional (feature-gated) | (has code fallback) | Yes | Yes | Backend/Node |
| `SAM_GOV_API_KEY` | Optional (feature-gated) |  | Yes | No | Backend/Node |
| `SEED_PATH` | Optional |  | Yes | No | Backend/Node |
| `SENTRY_DSN` | Optional (feature-gated) |  | No | Yes |  |
| `SERVICE_APPLICATION_EMAIL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_ADMIN_TOKEN` | Optional (feature-gated) | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_API_BASE_URL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_API_CONCURRENCY` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_API_PORT` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_API_TIMEOUT_MS` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_BASE_PATH` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_BASE_URL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_BULK_KEY` | Optional (feature-gated) | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_DEBUG` | Optional |  | Yes | No | Backend/Node |
| `SMOKE_MAX_CLICKS` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_MAX_PER_SELECTOR` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_MAX_ROUTES` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_MODE` | Optional |  | Yes | No | Backend/Node |
| `SMOKE_ROUTE_CLICK_BUDGET_MS` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_TARGET_PATH` | Optional |  | Yes | No | Backend/Node |
| `SMOKE_UI_BASE_URL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `SMOKE_UI_PORT` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `TEST_EMAIL` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `TEST_STATE` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `TWILIO_ACCOUNT_SID` | Optional | (has code fallback) | Yes | Yes | Backend/Node |
| `TWILIO_AUTH_TOKEN` | Optional (feature-gated) | (has code fallback) | Yes | Yes | Backend/Node |
| `TWILIO_FROM_NUMBER` | Optional | (has code fallback) | Yes | No | Backend/Node |
| `TWILIO_MESSAGING_SERVICE_SID` | Optional | (has code fallback) | Yes | Yes | Backend/Node |
| `VERIFY_ADMIN_TOKEN` | Optional (feature-gated) |  | Yes | No | Backend/Node |
| `VERIFY_BASE_URL` | Optional |  | Yes | No | Backend/Node |
| `VITE_API_PROXY_TARGET` | Optional | http://localhost:8080 | Yes | Yes | Backend/Node |
| `VITE_API_URL` | Optional | http://localhost:8080 | Yes | Yes | Used in both backend + frontend |
| `VITE_APP_BASE` | Optional | /grantflow | Yes | Yes | Used in both backend + frontend |
| `VITE_ASSET_BASE` | Optional | /grantflow | Yes | Yes | Backend/Node |

## Usage locations (file + line ranges)

### `ADMIN_EMAIL`

- **Templates**:
  - `.env.example:21` = `admin@grantflow.local`
  - `backend/env.example:10` = `admin@grantflow.local`
- **Code references**:
  - `backend/config/constants.js:8-8` (process.env)
  - `backend/server.js:61-61` (process.env)
  - `backend/services/anyaAdminTools.js:18-18` (process.env)
  - `backend/services/anyaOrchestrator.js:11-11` (process.env)
  - `scripts/anya-run-real-crawlers-all.mjs:31-31` (process.env)
  - `scripts/ensure-admin-user.mjs:19-19` (process.env)

### `ADMIN_NAME`

- **Templates**:
  - `.env.example:20` = `Local Admin`
  - `backend/env.example:9` = `Local Admin`
- **Code references**:
  - `backend/server.js:60-60` (process.env)
  - `scripts/ensure-admin-user.mjs:21-21` (process.env)

### `ADMIN_PHONE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/ensure-admin-user.mjs:20-20` (process.env)

### `ADMIN_TOKEN`

- **Templates**:
  - `.env.example:19` = `dev-admin-token`
  - `backend/env.example:8` = `dev-admin-token`
- **Code references**:
  - `backend/routes/anya.js:19-19` (process.env)
  - `backend/server.js:59-669` (process.env)
  - `scripts/diagnose-anya.mjs:20-20` (process.env)
  - `scripts/doctor.mjs:115-115` (process.env)

### `ALLOW_MOCK_AI`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/mockAI.js:9-9` (process.env)

### `ANALYTICS_WRITE_KEY`

- **Templates**:
  - `backend/env.example:87` = ``
- **Code references**: (none)

### `ANTHROPIC_API_KEY`

- **Templates**:
  - `.env.example:31` = ``
  - `backend/env.example:40` = `sk-ant-your-anthropic-key`
- **Code references**:
  - `backend/routes/anya.js:52-111` (process.env)
  - `backend/services/diagnosticsService.js:177-177` (process.env)
  - `scripts/diagnose-anya.mjs:26-40` (process.env)
  - `scripts/test-anya-ai.mjs:23-101` (process.env)
  - `scripts/test-anya-full.mjs:46-46` (process.env)
  - `test-anya-simple.js:7-7` (process.env)

### `ANYA_ADMIN_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAdminTools.js:18-18` (process.env)
  - `scripts/anya-run-real-crawlers-all.mjs:31-31` (process.env)

### `ANYA_ADMIN_TOKEN`

- **Templates**:
  - `backend/env.example:13` = `anya-dev-token`
- **Code references**:
  - `backend/routes/anya.js:19-19` (process.env)
  - `backend/server.js:59-669` (process.env)
  - `backend/services/diagnosticsService.js:178-178` (process.env)
  - `scripts/diagnose-anya.mjs:20-20` (process.env)

### `ANYA_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:558-558` (process.env)

### `ANYA_AUTONOMOUS_ENABLED`

- **Templates**:
  - `backend/env.example:49` = `false`
- **Code references**:
  - `backend/server.js:985-985` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:15-15` (process.env)
  - `scripts/check-anya-status.mjs:23-107` (process.env)

### `ANYA_CODE_CRAWL`

- **Templates**:
  - `backend/env.example:58` = `true              # Scan and fix code issues`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:24-24` (process.env)

### `ANYA_CRAWLERS`

- **Templates**:
  - `backend/env.example:60` = `true                # Run grant crawlers`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:26-26` (process.env)

### `ANYA_DRY_RUN`

- **Templates**:
  - `backend/env.example:74` = `false                # Dry run mode (no actual changes)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:38-47` (process.env)

### `ANYA_FIX_CONSOLE`

- **Templates**:
  - `backend/env.example:63` = `true             # Fix console.log statements`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:35-35` (process.env)

### `ANYA_FIX_EMPTY_CATCH`

- **Templates**:
  - `backend/env.example:64` = `true         # Fix empty catch blocks`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:36-36` (process.env)

### `ANYA_FIX_ERRORS`

- **Templates**:
  - `backend/env.example:73` = `false             # Auto-fix found errors`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:46-46` (process.env)

### `ANYA_FUNCTION_TESTS`

- **Templates**:
  - `backend/env.example:59` = `true          # Test API endpoints`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:25-25` (process.env)

### `ANYA_MATCH_THRESHOLD`

- **Templates**:
  - `backend/env.example:68` = `80           # Min % match to save to profile (0-100)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:41-41` (process.env)

### `ANYA_MAX_FILE_CHANGES`

- **Templates**:
  - `backend/env.example:65` = `20          # Max files to modify per run`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:37-37` (process.env)

### `ANYA_OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:34-34` (process.env)

### `ANYA_RUN_ON_ADMIN_LOGIN`

- **Templates**:
  - `backend/env.example:53` = `false    # Run when admin logs in`
- **Code references**:
  - `backend/routes/auth.js:1393-1393` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:19-19` (process.env)

### `ANYA_RUN_ON_SCHEDULE`

- **Templates**:
  - `backend/env.example:54` = `false       # Run on schedule (cron)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:20-20` (process.env)

### `ANYA_RUN_ON_STARTUP`

- **Templates**:
  - `backend/env.example:52` = `false        # Run when server starts`
- **Code references**:
  - `backend/server.js:987-987` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:18-18` (process.env)
  - `scripts/check-anya-status.mjs:24-24` (process.env)

### `ANYA_SAVE_GLOBAL`

- **Templates**:
  - `backend/env.example:69` = `true             # Save all opportunities globally`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:42-42` (process.env)

### `ANYA_SCHEDULE`

- **Templates**:
  - `backend/env.example:55` = `0 3 * * *           # Cron schedule (default: 3 AM daily)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:30-30` (process.env)

### `ANYA_WAIT_COMPLETION`

- **Templates**:
  - `backend/env.example:70` = `false        # Wait for crawlers to complete`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:43-43` (process.env)

### `API_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-auth-diagnostics.mjs:12-12` (process.env)
  - `tests/smoke/smoke.spec.mjs:18-18` (process.env)

### `API_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/diagnose-anya.mjs:19-19` (process.env)
  - `scripts/test-email-endpoint.mjs:9-9` (process.env)

### `APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/profiles.js:780-780` (process.env)

### `APP_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:125-125` (process.env)

### `ARTIFACTS_DIR`

- **Templates**: (not present)
- **Code references**:
  - `tests/smoke/playwright.config.mjs:3-4` (process.env)
  - `tests/smoke/smoke.spec.mjs:6-6` (process.env)

### `AUTH_ACCESS_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:17` = `10800`
- **Code references**:
  - `backend/routes/auth.js:99-99` (process.env)

### `AUTH_EMAIL_CODE_TTL`

- **Templates**:
  - `backend/env.example:19` = `600`
- **Code references**:
  - `backend/routes/auth.js:101-101` (process.env)

### `AUTH_EMAIL_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:169-169` (process.env)

### `AUTH_EMAIL_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:20` = `45`
- **Code references**:
  - `backend/routes/auth.js:102-102` (process.env)

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
  - `backend/env.example:27` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:125-125` (process.env)
  - `backend/server.js:137-137` (process.env)
  - `scripts/_doctor/http-proof.mjs:17-17` (process.env)

### `AUTH_FRONTEND_URL`

- **Templates**:
  - `backend/env.example:26` = `http://localhost:5173`
- **Code references**:
  - `backend/routes/auth.js:123-123` (process.env)

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
  - `.env.example:27` = `dev-secret-change-me`
  - `backend/env.example:16` = `dev-secret-change-me`
- **Code references**:
  - `backend/routes/auth.js:37-37` (process.env)
  - `backend/server.js:533-666` (process.env)

### `AUTH_OAUTH_STATE_TTL`

- **Templates**:
  - `backend/env.example:23` = `600`
- **Code references**:
  - `backend/routes/auth.js:105-105` (process.env)

### `AUTH_PHONE_CODE_TTL`

- **Templates**:
  - `backend/env.example:21` = `600`
- **Code references**:
  - `backend/routes/auth.js:103-103` (process.env)

### `AUTH_PHONE_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:176-176` (process.env)

### `AUTH_PHONE_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:22` = `60`
- **Code references**:
  - `backend/routes/auth.js:104-104` (process.env)

### `AUTH_PUBLIC_URL`

- **Templates**:
  - `backend/env.example:25` = `http://localhost:5173/grantflow`
- **Code references**:
  - `backend/routes/auth.js:122-122` (process.env)

### `AUTH_REFRESH_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:18` = `2592000`
- **Code references**:
  - `backend/routes/auth.js:100-100` (process.env)

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
  - `scripts/runtime-crawl-local.mjs:21-21` (process.env)

### `BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `src/components/anya/AnyaChat.jsx:452-452` (import.meta.env)
  - `src/components/anya/AnyaFloatingButton.jsx:40-79` (import.meta.env)
  - `src/components/onboarding/OnboardingVideo.jsx:16-16` (import.meta.env)
  - `tests/smoke/playwright.config.mjs:21-21` (process.env)
  - `tests/smoke/smoke.spec.mjs:16-16` (process.env)

### `BULK_POPULATE_KEY`

- **Templates**:
  - `.env.example:39` = `grantflow-bulk-2026`
- **Code references**:
  - `backend/routes/crawlerV2.js:9-9` (process.env)
  - `backend/routes/crawlers.js:1240-1801` (process.env)
  - `backend/server.js:550-670` (process.env)
  - `scripts/doctor.mjs:252-252` (process.env)
  - `tests/smoke/smoke.spec.mjs:21-21` (process.env)

### `CORS_ORIGIN`

- **Templates**:
  - `.env.example:24` = `http://localhost:5173,http://127.0.0.1:5173`
  - `backend/env.example:12` = `http://localhost:5173,http://127.0.0.1:5173`
- **Code references**:
  - `backend/server.js:81-82` (process.env)
  - `scripts/doctor.mjs:118-118` (process.env)

### `CRAWLER_MAX_SOURCES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-doctor.mjs:134-134` (process.env)
  - `scripts/crawler-run.mjs:25-25` (process.env)
  - `scripts/crawler-smoke.mjs:21-21` (process.env)

### `CRAWLER_MAX_URLS_PER_SOURCE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:26-26` (process.env)
  - `scripts/crawler-smoke.mjs:22-22` (process.env)

### `CRAWLER_MODE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:22-22` (process.env)

### `CRAWLER_STALE_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/crawlerV2.js:38-38` (process.env)

### `CRAWLER_STATE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:23-23` (process.env)

### `CRAWLER_TIMEOUT_SECONDS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:27-27` (process.env)
  - `scripts/crawler-smoke.mjs:23-23` (process.env)

### `CRAWLER_USE_LIVE_SOURCES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:24-24` (process.env)

### `DATABASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/migrations/run-migration.js:15-15` (process.env)
  - `scripts/fix-malformed-json.mjs:20-20` (process.env)
  - `scripts/ingest-grantsgov.mjs:17-17` (process.env)
  - `scripts/ingest-usaspending.mjs:17-17` (process.env)
  - `scripts/ingest.mjs:18-18` (process.env)
  - `scripts/seed-profile-grants.mjs:18-18` (process.env)
  - `scripts/seed-real-opportunities.mjs:18-18` (process.env)

### `DATABASE_URL`

- **Templates**:
  - `.env.example:16` = `backend/data/grantflow.dev.db`
  - `backend/env.example:6` = `backend/data/grantflow.dev.db`
- **Code references**:
  - `backend/import-data.js:24-24` (process.env)
  - `backend/server.js:159-159` (process.env)
  - `scripts/anya-run-real-crawlers-all.mjs:20-20` (process.env)
  - `scripts/crawler-doctor.mjs:18-18` (process.env)
  - `scripts/crawler-run.mjs:19-19` (process.env)
  - `scripts/crawler-smoke.mjs:15-15` (process.env)
  - `scripts/opportunities-national-minimum.mjs:20-20` (process.env)
  - `tests/crawler/smoke/nationalCrawlerV2.test.js:11-11` (process.env)

### `DB_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:713-713` (process.env)
  - `backend/services/diagnosticsService.js:63-180` (process.env)
  - `backend/tests/crawlerMatrixTest.js:26-26` (process.env)
  - `scripts/build-seed-db.mjs:41-41` (process.env)
  - `scripts/check-profiles.mjs:42-43` (process.env)
  - `scripts/ensure-admin-user.mjs:24-24` (process.env)
  - `scripts/reattach-users-simple.mjs:10-11` (process.env)
  - `scripts/run-crawlers.mjs:23-24` (process.env)
  - `scripts/seed-profiles.mjs:44-45` (process.env)

### `DEV`

- **Templates**: (not present)
- **Code references**:
  - `src/api/client.js:6-6` (import.meta.env)

### `ENABLE_MIN_NATIONAL_ENSURE`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:478-478` (process.env)

### `FIREBASE_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:5-5` (process.env)

### `FIREBASE_APP_ID`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:10-10` (process.env)

### `FIREBASE_AUTH_DOMAIN`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:6-6` (process.env)

### `FIREBASE_MESSAGING_SENDER_ID`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:9-9` (process.env)

### `FIREBASE_PROJECT_ID`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:7-7` (process.env)

### `FIREBASE_STORAGE_BUCKET`

- **Templates**: (not present)
- **Code references**:
  - `src/lib/firebase.js:8-8` (process.env)

### `FORCE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/build-seed-db.mjs:17-52` (process.env)

### `FROM_EMAIL`

- **Templates**:
  - `.env.example:33` = `noreply@grantflow.local`
  - `backend/env.example:44` = `noreply@yourdomain.com`
- **Code references**:
  - `backend/services/email.js:7-7` (process.env)

### `FRONTEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:123-123` (process.env)

### `GOOGLE_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:19-19` (process.env)

### `GOOGLE_SEARCH_CX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:20-20` (process.env)

### `ITEM_REQUEST`

- **Templates**: (not present)
- **Code references**:
  - `scripts/anya-run-real-crawlers-all.mjs:27-27` (process.env)

### `JWT_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:37-37` (process.env)
  - `backend/server.js:533-666` (process.env)

### `LOG_LEVEL`

- **Templates**:
  - `backend/env.example:85` = `debug`
- **Code references**: (none)

### `MIN_NATIONAL_OPPORTUNITIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:474-474` (process.env)
  - `scripts/opportunities-national-minimum.mjs:138-138` (process.env)

### `MIN_NATIONAL_VISIBLE`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:224-224` (process.env)
  - `scripts/opportunities-national-minimum.mjs:85-85` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:1007-1007` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:1009-1009` (process.env)

### `NATIONAL_PROGRAMS_MAX_DEPTH`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:1013-1013` (process.env)

### `NATIONAL_PROGRAMS_MAX_URLS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:1012-1012` (process.env)

### `NODE_ENV`

- **Templates**:
  - `.env.example:12` = `development`
  - `backend/env.example:5` = `development`
- **Code references**:
  - `backend/middleware/errorHandler.js:11-11` (process.env)
  - `backend/routes/anya.js:121-121` (process.env)
  - `backend/routes/auth.js:1122-1801` (process.env)
  - `backend/routes/reminders.js:135-154` (process.env)
  - `backend/server.js:52-935` (process.env)
  - `backend/services/anyaTestRepair.js:155-155` (process.env)
  - `backend/services/crawlers/itemFundingCrawler.js:236-236` (process.env)
  - `backend/services/diagnosticsService.js:30-179` (process.env)
  - `backend/services/mockAI.js:9-9` (process.env)
  - `scripts/_doctor/http-proof.mjs:25-25` (process.env)
  - `scripts/build-seed-db.mjs:15-15` (process.env)
  - `scripts/seed-profiles.mjs:28-28` (process.env)
  - `src/components/auth/AuthErrorBoundary.jsx:84-84` (process.env)
  - `src/components/shared/ErrorBoundary.jsx:16-16` (process.env)

### `OPENAI_API_KEY`

- **Templates**:
  - `.env.example:30` = ``
  - `backend/env.example:37` = `sk-your-openai-key`
- **Code references**:
  - `backend/routes/admin.js:65-65` (process.env)
  - `backend/routes/ai.js:16-16` (process.env)
  - `backend/routes/anya.js:53-118` (process.env)
  - `backend/routes/auth.js:29-29` (process.env)
  - `backend/routes/crawlers.js:26-26` (process.env)
  - `backend/routes/profiles.js:130-130` (process.env)
  - `backend/server.js:654-654` (process.env)
  - `backend/services/anyaOrchestrator.js:18-18` (process.env)
  - `backend/services/anyaToolRegistry.js:726-726` (process.env)
  - `backend/services/diagnosticsService.js:176-176` (process.env)
  - `scripts/doctor.mjs:129-129` (process.env)
  - `scripts/fix-api-errors.mjs:25-27` (process.env)
  - `scripts/test-anya-ai.mjs:24-105` (process.env)
  - `scripts/test-anya-full.mjs:97-97` (process.env)

### `OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/constants.js:34-34` (process.env)
  - `backend/routes/admin.js:19-19` (process.env)

### `PORT`

- **Templates**:
  - `.env.example:13` = `8080`
  - `backend/env.example:4` = `8080`
- **Code references**:
  - `backend/server.js:70-70` (process.env)
  - `scripts/_doctor/http-proof.mjs:16-16` (process.env)
  - `tests/smoke/smoke.spec.mjs:11-11` (process.env)

### `PUBLIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:122-122` (process.env)

### `REQUEST_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:96-96` (process.env)

### `RESEND_API_KEY`

- **Templates**:
  - `.env.example:32` = ``
  - `backend/env.example:43` = `re_your-resend-key`
- **Code references**:
  - `backend/services/email.js:6-6` (process.env)

### `SAM_GOV_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaToolRegistry.js:727-727` (process.env)
  - `backend/services/connectors/samGovConnector.js:61-118` (process.env)
  - `backend/services/diagnosticsService.js:175-175` (process.env)

### `SEED_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/seed-profiles.mjs:51-52` (process.env)

### `SENTRY_DSN`

- **Templates**:
  - `backend/env.example:86` = ``
- **Code references**: (none)

### `SERVICE_APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/serviceApplication.js:7-7` (process.env)

### `SMOKE_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:251-251` (process.env)
  - `tests/smoke/smoke.spec.mjs:20-20` (process.env)

### `SMOKE_API_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `tests/smoke/smoke.spec.mjs:18-18` (process.env)

### `SMOKE_API_CONCURRENCY`

- **Templates**: (not present)
- **Code references**:
  - `tests/smoke/smoke.spec.mjs:312-312` (process.env)

### `SMOKE_API_PORT`

- **Templates**: (not present)
- **Code references**:
  - `tests/smoke/smoke.spec.mjs:11-11` (process.env)

### `SMOKE_API_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `tests/smoke/smoke.spec.mjs:268-268` (process.env)

### `SMOKE_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:249-249` (process.env)
  - `scripts/smoke-auth-callback.mjs:49-49` (process.env)
  - `scripts/smoke-auth-refresh.mjs:51-51` (process.env)
  - `scripts/smoke-login.mjs:29-29` (process.env)
  - `scripts/smoke-organization-profile.mjs:51-51` (process.env)
  - `tests/smoke/smoke.spec.mjs:19-19` (process.env)

### `SMOKE_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:20-20` (process.env)
  - `scripts/smoke-auth-callback.mjs:17-17` (process.env)
  - `scripts/smoke-auth-refresh.mjs:19-19` (process.env)
  - `scripts/smoke-login.mjs:16-16` (process.env)
  - `scripts/smoke-organization-profile.mjs:19-19` (process.env)
  - `tests/smoke/playwright.config.mjs:20-20` (process.env)
  - `tests/smoke/smoke.spec.mjs:16-16` (process.env)

### `SMOKE_BULK_KEY`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:252-252` (process.env)
  - `tests/smoke/smoke.spec.mjs:21-21` (process.env)

### `SMOKE_DEBUG`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-login.mjs:58-72` (process.env)

### `SMOKE_MAX_CLICKS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:256-256` (process.env)
  - `tests/smoke/smoke.spec.mjs:99-99` (process.env)

### `SMOKE_MAX_PER_SELECTOR`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:257-257` (process.env)
  - `tests/smoke/smoke.spec.mjs:100-100` (process.env)

### `SMOKE_MAX_ROUTES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:255-255` (process.env)
  - `tests/smoke/smoke.spec.mjs:61-61` (process.env)

### `SMOKE_MODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:122-656` (process.env)
  - `backend/routes/anya.js:325-361` (process.env)
  - `backend/services/crawlers/itemFundingCrawler.js:236-236` (process.env)

### `SMOKE_ROUTE_CLICK_BUDGET_MS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:258-258` (process.env)
  - `tests/smoke/smoke.spec.mjs:102-102` (process.env)

### `SMOKE_TARGET_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-login.mjs:30-30` (process.env)

### `SMOKE_UI_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `tests/smoke/playwright.config.mjs:19-19` (process.env)
  - `tests/smoke/smoke.spec.mjs:16-16` (process.env)

### `SMOKE_UI_PORT`

- **Templates**: (not present)
- **Code references**:
  - `tests/smoke/playwright.config.mjs:22-22` (process.env)
  - `tests/smoke/smoke.spec.mjs:10-10` (process.env)

### `TEST_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/test-email-endpoint.mjs:10-10` (process.env)

### `TEST_STATE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/opportunities-national-minimum.mjs:139-139` (process.env)

### `TWILIO_ACCOUNT_SID`

- **Templates**:
  - `.env.example:34` = ``
  - `backend/env.example:30` = `ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:117-117` (process.env)

### `TWILIO_AUTH_TOKEN`

- **Templates**:
  - `.env.example:35` = ``
  - `backend/env.example:31` = `your-twilio-auth-token`
- **Code references**:
  - `backend/routes/auth.js:118-118` (process.env)

### `TWILIO_FROM_NUMBER`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:120-120` (process.env)

### `TWILIO_MESSAGING_SERVICE_SID`

- **Templates**:
  - `.env.example:36` = ``
  - `backend/env.example:32` = `MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:119-119` (process.env)

### `VERIFY_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-login.mjs:5-5` (process.env)

### `VERIFY_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-login.mjs:4-4` (process.env)

### `VITE_API_PROXY_TARGET`

- **Templates**:
  - `.env.example:47` = `http://localhost:8080`
- **Code references**:
  - `scripts/doctor.mjs:72-72` (process.env)

### `VITE_API_URL`

- **Templates**:
  - `.env.example:50` = `http://localhost:8080`
  - `env.example:4` = `http://localhost:8080`
- **Code references**:
  - `scripts/doctor.mjs:74-74` (process.env)
  - `src/api/client.js:7-7` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:35-63` (import.meta.env)

### `VITE_APP_BASE`

- **Templates**:
  - `.env.example:44` = `/grantflow`
  - `env.example:5` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:125-125` (process.env)
  - `backend/server.js:137-137` (process.env)
  - `scripts/_doctor/http-proof.mjs:17-17` (process.env)
  - `scripts/doctor.mjs:69-249` (process.env)
  - `src/App.jsx:54-54` (import.meta.env)
  - `src/api/client.js:9-9` (import.meta.env)
  - `src/components/auth/SessionExpiredDialog.jsx:10-10` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:24-24` (import.meta.env)

### `VITE_ASSET_BASE`

- **Templates**:
  - `.env.example:53` = `/grantflow`
- **Code references**:
  - `scripts/doctor.mjs:70-227` (process.env)
