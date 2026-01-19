# ENV Vars Inventory

This file is **generated** by `node scripts/inventory-env.mjs`.
It enumerates environment variables referenced in code and/or present in example env files.

## Summary

- Total vars: **201**
- Vars referenced in code: **191**
- Vars present in env templates: **66**

## Inventory

| Name | Referenced in code | Defined in templates | Notes |
| --- | --- | --- | --- |
| `ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `ADMIN_EMAILS` | Yes | No | Backend/Node |
| `ADMIN_LOGIN_EVENT_BUFFER` | Yes | No | Backend/Node |
| `ADMIN_NAME` | Yes | Yes | Backend/Node |
| `ADMIN_PHONE` | Yes | No | Backend/Node |
| `ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ALLOW_EPHEMERAL_SQLITE` | Yes | No | Backend/Node |
| `ALLOW_LEGACY_PROFILE_TOKEN` | Yes | Yes | Backend/Node |
| `ALLOW_MOCK_AI` | Yes | No | Backend/Node |
| `ANALYTICS_WRITE_KEY` | No | Yes |  |
| `ANTHROPIC_API_KEY` | Yes | Yes | Backend/Node |
| `ANTHROPIC_MODEL` | Yes | No | Backend/Node |
| `ANYA_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ANYA_ANTHROPIC_COOLDOWN_MS` | Yes | No | Backend/Node |
| `ANYA_ANTHROPIC_FAILURE_THRESHOLD` | Yes | No | Backend/Node |
| `ANYA_ANTHROPIC_MAX_RETRIES` | Yes | No | Backend/Node |
| `ANYA_ANTHROPIC_TIMEOUT_MS` | Yes | No | Backend/Node |
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
| `ANYA_OPENAI_COOLDOWN_MS` | Yes | No | Backend/Node |
| `ANYA_OPENAI_FAILURE_THRESHOLD` | Yes | No | Backend/Node |
| `ANYA_OPENAI_MAX_RETRIES` | Yes | No | Backend/Node |
| `ANYA_OPENAI_MODEL` | Yes | No | Backend/Node |
| `ANYA_OPENAI_TIMEOUT_MS` | Yes | No | Backend/Node |
| `ANYA_RUN_ON_ADMIN_LOGIN` | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `ANYA_SAVE_GLOBAL` | Yes | Yes | Backend/Node |
| `ANYA_SCHEDULE` | Yes | Yes | Backend/Node |
| `ANYA_WAIT_COMPLETION` | Yes | Yes | Backend/Node |
| `API_BASE_URL` | Yes | No | Backend/Node |
| `API_DATA_GOV_KEY` | Yes | No | Backend/Node |
| `API_URL` | Yes | No | Backend/Node |
| `APPLICATION_EMAIL` | Yes | No | Backend/Node |
| `APP_BASE_PATH` | Yes | No | Backend/Node |
| `AUTH_ACCESS_TOKEN_TTL` | Yes | Yes | Backend/Node |
| `AUTH_ALLOW_PREVIEW_CODE_IN_PROD` | Yes | Yes | Backend/Node |
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
| `AUTH_NOTIFY_ON_LOGIN` | Yes | Yes | Backend/Node |
| `AUTH_OAUTH_STATE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_CODE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_RATE_LIMIT` | Yes | No | Backend/Node |
| `AUTH_PHONE_RESEND_SECONDS` | Yes | Yes | Backend/Node |
| `AUTH_PUBLIC_URL` | Yes | Yes | Backend/Node |
| `AUTH_REFRESH_TOKEN_TTL` | Yes | Yes | Backend/Node |
| `AUTH_YAHOO_CLIENT_ID` | No | Yes |  |
| `AUTH_YAHOO_CLIENT_SECRET` | No | Yes |  |
| `BACKEND_BASE_URL` | Yes | No | Backend/Node |
| `BASELINE_SEED_MODE` | Yes | No | Backend/Node |
| `BASE_URL` | Yes | No | Used in both backend + frontend |
| `BUILD_TIMESTAMP` | Yes | No | Backend/Node |
| `BULK_POPULATE_KEY` | Yes | Yes | Backend/Node |
| `CI` | Yes | No | Backend/Node |
| `COMMIT_SHA` | Yes | No | Backend/Node |
| `CONFIRM` | Yes | No | Backend/Node |
| `CORS_ORIGIN` | Yes | Yes | Backend/Node |
| `CRAWLER_MAX_SOURCES` | Yes | No | Backend/Node |
| `CRAWLER_MAX_URLS_PER_SOURCE` | Yes | No | Backend/Node |
| `CRAWLER_MODE` | Yes | No | Backend/Node |
| `CRAWLER_STALE_DAYS` | Yes | No | Backend/Node |
| `CRAWLER_STATE` | Yes | No | Backend/Node |
| `CRAWLER_TIMEOUT_MS` | Yes | No | Backend/Node |
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
| `ENABLE_ASSISTANCE_DIRECTORIES_SEED` | Yes | Yes | Backend/Node |
| `ENABLE_MIN_NATIONAL_ENSURE` | Yes | Yes | Backend/Node |
| `FEATURE_ANYA_TOOLS` | Yes | No | Backend/Node |
| `FEATURE_AUTO_REPAIR` | Yes | No | Backend/Node |
| `FEATURE_CRAWLER_RETRIES` | Yes | No | Backend/Node |
| `FEATURE_DETAILED_MATCHING` | Yes | No | Backend/Node |
| `FEATURE_GEO_CRAWL` | Yes | No | Backend/Node |
| `FORCE` | Yes | No | Backend/Node |
| `FROM_EMAIL` | Yes | Yes | Backend/Node |
| `FRONTEND_BASE_URL` | Yes | No | Backend/Node |
| `FUNDING_APIS_REQUIRE_KEYS` | Yes | No | Backend/Node |
| `GEO_COUNTIES_BY_STATE_PATH` | Yes | Yes | Backend/Node |
| `GEO_ZIP_COORDINATES_PATH` | Yes | Yes | Backend/Node |
| `GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `GOOGLE_API_KEY` | Yes | No | Backend/Node |
| `GOOGLE_SEARCH_CX` | Yes | No | Backend/Node |
| `GRANTS_GOV_API_KEY` | Yes | No | Backend/Node |
| `JWT_SECRET` | Yes | No | Backend/Node |
| `LIMIT` | Yes | No | Backend/Node |
| `LIVE_CRAWL_PERSIST_OPPS` | Yes | No | Backend/Node |
| `LIVE_CRAWL_TIMEOUT_MS` | Yes | No | Backend/Node |
| `LOG_LEVEL` | No | Yes |  |
| `MAX_PROFILES` | Yes | No | Backend/Node |
| `MIGRATE_ASSERT_FRESH` | Yes | No | Backend/Node |
| `MIGRATE_VERIFY_COUNTS` | Yes | No | Backend/Node |
| `MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK` | Yes | No | Backend/Node |
| `MIN_NATIONAL_OPPORTUNITIES` | Yes | No | Backend/Node |
| `MIN_NATIONAL_VISIBLE` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_ENABLED` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_DEPTH` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_URLS` | Yes | No | Backend/Node |
| `NODE_ENV` | Yes | Yes | Backend/Node |
| `OPENAI_API_KEY` | Yes | Yes | Backend/Node |
| `OPENAI_MAX_RETRIES` | Yes | No | Backend/Node |
| `OPENAI_MODEL` | Yes | No | Backend/Node |
| `OPENAI_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PDF_PATH` | Yes | No | Backend/Node |
| `PGDATABASE` | Yes | No | Backend/Node |
| `PGHOST` | Yes | No | Backend/Node |
| `PGPASSWORD` | Yes | No | Backend/Node |
| `PGPORT` | Yes | No | Backend/Node |
| `PGSSLMODE` | Yes | No | Backend/Node |
| `PGUSER` | Yes | No | Backend/Node |
| `PG_POOL_CONN_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PG_POOL_IDLE_MS` | Yes | No | Backend/Node |
| `PG_POOL_MAX` | Yes | No | Backend/Node |
| `PORT` | Yes | Yes | Backend/Node |
| `POSTGRES_DB` | Yes | No | Backend/Node |
| `POSTGRES_HOST` | Yes | No | Backend/Node |
| `POSTGRES_PASSWORD` | Yes | No | Backend/Node |
| `POSTGRES_PORT` | Yes | No | Backend/Node |
| `POSTGRES_USER` | Yes | No | Backend/Node |
| `PROD` | Yes | No | Frontend (Vite) |
| `PUBLIC_URL` | Yes | No | Backend/Node |
| `RAILWAY_DEPLOYMENT_ID` | Yes | No | Backend/Node |
| `RAILWAY_DEPLOYMENT_START_TIME` | Yes | No | Backend/Node |
| `RAILWAY_ENVIRONMENT` | Yes | No | Backend/Node |
| `RAILWAY_GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `RAILWAY_PROJECT_ID` | Yes | No | Backend/Node |
| `RAILWAY_SERVICE_ID` | Yes | No | Backend/Node |
| `RAILWAY_STATIC_URL` | Yes | No | Backend/Node |
| `REQUEST_ID_ERROR_STORE_MAX` | Yes | No | Backend/Node |
| `REQUEST_TIMEOUT_MS` | Yes | No | Backend/Node |
| `RESEND_API_KEY` | Yes | Yes | Backend/Node |
| `RUNTIME_SECRETS_KEY` | Yes | No | Backend/Node |
| `RUN_SQLITE_MIGRATION` | Yes | No | Backend/Node |
| `SAM_GOV_API_KEY` | Yes | No | Backend/Node |
| `SAM_GOV_PUBLIC_API_KEY` | Yes | No | Backend/Node |
| `SEED_KEY` | Yes | No | Backend/Node |
| `SEED_PATH` | Yes | No | Backend/Node |
| `SENTRY_DSN` | No | Yes |  |
| `SERVICE_APPLICATION_EMAIL` | Yes | No | Backend/Node |
| `SESSION_SECRET` | Yes | No | Backend/Node |
| `SIMPLER_GRANTS_API_KEY` | Yes | No | Backend/Node |
| `SMOKE_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `SMOKE_API_BASE` | Yes | No | Backend/Node |
| `SMOKE_BASE_PATH` | Yes | No | Backend/Node |
| `SMOKE_BASE_URL` | Yes | No | Backend/Node |
| `SMOKE_CHECK_PROFILE_SCHEMA` | Yes | No | Backend/Node |
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
| `VITE_API_PROXY_TARGET` | No | Yes |  |
| `VITE_API_URL` | Yes | Yes | Frontend (Vite) |
| `VITE_APP_BASE` | Yes | Yes | Used in both backend + frontend |
| `VITE_ASSET_BASE` | Yes | Yes | Backend/Node |
| `VITE_CANONICAL_HOST` | Yes | No | Frontend (Vite) |
| `VITE_CANONICAL_HOST_STRICT` | Yes | No | Frontend (Vite) |
| `VITE_DEV_ADMIN_TOKEN` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_API_KEY` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_APP_ID` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_PROJECT_ID` | Yes | No | Frontend (Vite) |
| `VITE_FIREBASE_STORAGE_BUCKET` | Yes | No | Frontend (Vite) |
| `X_ADMIN_TOKEN` | Yes | No | Backend/Node |

## Usage locations (file + line ranges)

### `ADMIN_EMAIL`

- **Templates**:
  - `backend/env.example:32` = `admin@grantflow.local`
- **Code references**:
  - `backend/config/constants.js:L11` (process.env)
  - `backend/server.js:L83` (process.env)
  - `backend/services/anyaOrchestrator.js:L12` (process.env)
  - `repo/backend/server.js:L57` (process.env)
  - `scripts/ensure-admin-user.mjs:L19` (process.env)

### `ADMIN_EMAILS`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/constants.js:L18` (process.env)

### `ADMIN_LOGIN_EVENT_BUFFER`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/adminLoginEventStore.js:L5` (process.env)

### `ADMIN_NAME`

- **Templates**:
  - `backend/env.example:31` = `Local Admin`
- **Code references**:
  - `backend/server.js:L82` (process.env)
  - `repo/backend/server.js:L56` (process.env)
  - `scripts/ensure-admin-user.mjs:L21` (process.env)

### `ADMIN_PHONE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/ensure-admin-user.mjs:L20` (process.env)

### `ADMIN_TOKEN`

- **Templates**:
  - `backend/env.example:30` = `dev-admin-token`
- **Code references**:
  - `backend/routes/anya.js:L19` (process.env)
  - `backend/server.js:L81–L967` (process.env)
  - `repo/backend/server.js:L55–L819` (process.env)
  - `scripts/diagnose-anya.mjs:L20` (process.env)
  - `scripts/doctor.mjs:L77` (process.env)
  - `scripts/run-all-real-crawlers.mjs:L5` (process.env)
  - `tests/unit/api-contracts.test.mjs:L72` (process.env)

### `ALLOW_EPHEMERAL_SQLITE`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L537` (process.env)
  - `repo/backend/db/index.js:L379` (process.env)

### `ALLOW_LEGACY_PROFILE_TOKEN`

- **Templates**:
  - `backend/env.example:34` = `false`
- **Code references**:
  - `backend/server.js:L857` (process.env)
  - `repo/backend/server.js:L721` (process.env)

### `ALLOW_MOCK_AI`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/mockAI.js:L9` (process.env)

### `ANALYTICS_WRITE_KEY`

- **Templates**:
  - `backend/env.example:143` = ``
- **Code references**: (none)

### `ANTHROPIC_API_KEY`

- **Templates**:
  - `backend/env.example:78` = `sk-ant-your-anthropic-key`
- **Code references**:
  - `backend/routes/ai.js:L37–L40` (process.env)
  - `backend/routes/anya.js:L50–L110` (process.env)
  - `backend/routes/profiles.js:L191–L194` (process.env)
  - `backend/server.js:L952` (process.env)
  - `backend/services/anyaOrchestrator.js:L37` (process.env)
  - `backend/services/diagnosticsService.js:L228` (process.env)
  - `backend/services/documentIngestion.js:L45` (process.env)
  - `backend/services/pipelineAutomation.js:L44` (process.env)
  - `backend/services/profileEnrichment.js:L7` (process.env)
  - `scripts/diagnose-anya.mjs:L26–L40` (process.env)

### `ANTHROPIC_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/ai.js:L90–L424` (process.env)
  - `backend/routes/profiles.js:L841–L957` (process.env)
  - `backend/services/anyaOrchestrator.js:L62` (process.env)
  - `backend/services/documentIngestion.js:L559` (process.env)
  - `backend/services/pipelineAutomation.js:L306` (process.env)
  - `backend/services/profileEnrichment.js:L188` (process.env)

### `ANYA_ADMIN_TOKEN`

- **Templates**:
  - `backend/env.example:42` = `anya-dev-token`
- **Code references**:
  - `backend/routes/anya.js:L19` (process.env)
  - `backend/server.js:L81–L967` (process.env)
  - `backend/services/diagnosticsService.js:L233` (process.env)
  - `repo/backend/server.js:L55–L819` (process.env)
  - `scripts/diagnose-anya.mjs:L20` (process.env)

### `ANYA_ANTHROPIC_COOLDOWN_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L32` (process.env)

### `ANYA_ANTHROPIC_FAILURE_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L31` (process.env)

### `ANYA_ANTHROPIC_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/ai.js:L42` (process.env)
  - `backend/routes/anya.js:L68` (process.env)
  - `backend/routes/profiles.js:L196` (process.env)
  - `backend/services/anyaOrchestrator.js:L43` (process.env)
  - `backend/services/documentIngestion.js:L51` (process.env)
  - `backend/services/pipelineAutomation.js:L50` (process.env)
  - `backend/services/profileEnrichment.js:L13` (process.env)

### `ANYA_ANTHROPIC_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/ai.js:L41` (process.env)
  - `backend/routes/anya.js:L67` (process.env)
  - `backend/routes/profiles.js:L195` (process.env)
  - `backend/services/anyaOrchestrator.js:L42` (process.env)
  - `backend/services/documentIngestion.js:L50` (process.env)
  - `backend/services/pipelineAutomation.js:L49` (process.env)
  - `backend/services/profileEnrichment.js:L12` (process.env)

### `ANYA_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L778–L778` (process.env)
  - `repo/backend/server.js:L648–L648` (process.env)

### `ANYA_AUTONOMOUS_ENABLED`

- **Templates**:
  - `backend/env.example:105` = `false`
- **Code references**:
  - `backend/server.js:L1454` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L15` (process.env)
  - `repo/backend/server.js:L1205` (process.env)
  - `scripts/check-anya-status.mjs:L23–L107` (process.env)

### `ANYA_CODE_CRAWL`

- **Templates**:
  - `backend/env.example:114` = `true              # Scan and fix code issues`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L24` (process.env)

### `ANYA_CRAWLERS`

- **Templates**:
  - `backend/env.example:116` = `true                # Run grant crawlers`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L26` (process.env)

### `ANYA_DRY_RUN`

- **Templates**:
  - `backend/env.example:130` = `false                # Dry run mode (no actual changes)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L38–L47` (process.env)

### `ANYA_FIX_CONSOLE`

- **Templates**:
  - `backend/env.example:119` = `true             # Fix console.log statements`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L35` (process.env)

### `ANYA_FIX_EMPTY_CATCH`

- **Templates**:
  - `backend/env.example:120` = `true         # Fix empty catch blocks`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L36` (process.env)

### `ANYA_FIX_ERRORS`

- **Templates**:
  - `backend/env.example:129` = `false             # Auto-fix found errors`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L46` (process.env)

### `ANYA_FUNCTION_TESTS`

- **Templates**:
  - `backend/env.example:115` = `true          # Test API endpoints`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L25` (process.env)

### `ANYA_MATCH_THRESHOLD`

- **Templates**:
  - `backend/env.example:124` = `80           # Min % match to save to profile (0-100)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L41` (process.env)

### `ANYA_MAX_FILE_CHANGES`

- **Templates**:
  - `backend/env.example:121` = `20          # Max files to modify per run`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L37` (process.env)

### `ANYA_OPENAI_COOLDOWN_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L18` (process.env)

### `ANYA_OPENAI_FAILURE_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L17` (process.env)

### `ANYA_OPENAI_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L78` (process.env)

### `ANYA_OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L61` (process.env)

### `ANYA_OPENAI_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L73` (process.env)

### `ANYA_RUN_ON_ADMIN_LOGIN`

- **Templates**:
  - `backend/env.example:109` = `false    # Run when admin logs in`
- **Code references**:
  - `backend/routes/auth.js:L1682` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L19` (process.env)

### `ANYA_RUN_ON_SCHEDULE`

- **Templates**:
  - `backend/env.example:110` = `false       # Run on schedule (cron)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L20` (process.env)

### `ANYA_RUN_ON_STARTUP`

- **Templates**:
  - `backend/env.example:108` = `false        # Run when server starts`
- **Code references**:
  - `backend/server.js:L1456` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L18` (process.env)
  - `repo/backend/server.js:L1207` (process.env)
  - `scripts/check-anya-status.mjs:L24` (process.env)

### `ANYA_SAVE_GLOBAL`

- **Templates**:
  - `backend/env.example:125` = `true             # Save all opportunities globally`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L42` (process.env)

### `ANYA_SCHEDULE`

- **Templates**:
  - `backend/env.example:111` = `0 3 * * *           # Cron schedule (default: 3 AM daily)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L30` (process.env)

### `ANYA_WAIT_COMPLETION`

- **Templates**:
  - `backend/env.example:126` = `false        # Wait for crawlers to complete`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L43` (process.env)

### `API_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-auth-diagnostics.mjs:L12` (process.env)
  - `tests/smoke/playwright.config.mjs:L4` (process.env)

### `API_DATA_GOV_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L226` (process.env)

### `API_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/diagnose-anya.mjs:L19` (process.env)

### `APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/profiles.js:L1319` (process.env)
  - `repo/backend/routes/profiles.js:L1092` (process.env)

### `APP_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L156` (process.env)

### `AUTH_ACCESS_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:55` = `10800`
- **Code references**:
  - `backend/routes/auth.js:L130` (process.env)

### `AUTH_ALLOW_PREVIEW_CODE_IN_PROD`

- **Templates**:
  - `backend/env.example:93` = `false`
- **Code references**:
  - `backend/routes/auth.js:L1425` (process.env)

### `AUTH_EMAIL_CODE_TTL`

- **Templates**:
  - `backend/env.example:57` = `600`
- **Code references**:
  - `backend/routes/auth.js:L132` (process.env)

### `AUTH_EMAIL_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L200` (process.env)

### `AUTH_EMAIL_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:58` = `45`
- **Code references**:
  - `backend/routes/auth.js:L133` (process.env)

### `AUTH_FACEBOOK_CLIENT_ID`

- **Templates**:
  - `backend/env.example:135` = `facebook-client-id`
- **Code references**: (none)

### `AUTH_FACEBOOK_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:136` = `facebook-client-secret`
- **Code references**: (none)

### `AUTH_FRONTEND_APP_BASE`

- **Templates**:
  - `backend/env.example:65` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L156` (process.env)
  - `backend/server.js:L293` (process.env)
  - `repo/backend/server.js:L192` (process.env)

### `AUTH_FRONTEND_URL`

- **Templates**:
  - `backend/env.example:64` = `http://localhost:5173`
- **Code references**:
  - `backend/routes/auth.js:L154` (process.env)
  - `backend/services/diagnosticsService.js:L237` (process.env)

### `AUTH_GOOGLE_CLIENT_ID`

- **Templates**:
  - `backend/env.example:133` = `google-client-id`
- **Code references**: (none)

### `AUTH_GOOGLE_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:134` = `google-client-secret`
- **Code references**: (none)

### `AUTH_JWT_SECRET`

- **Templates**:
  - `backend/env.example:54` = `dev-secret-change-me`
- **Code references**:
  - `backend/routes/auth.js:L40` (process.env)
  - `backend/server.js:L711–L964` (process.env)
  - `backend/utils/runtimeSecrets.js:L19` (process.env)
  - `repo/backend/server.js:L592–L816` (process.env)

### `AUTH_NOTIFY_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L232` (process.env)
  - `backend/services/email.js:L10` (process.env)

### `AUTH_NOTIFY_ON_LOGIN`

- **Templates**:
  - `backend/env.example:87` = `true`
- **Code references**:
  - `backend/services/diagnosticsService.js:L231` (process.env)
  - `backend/services/email.js:L13–L14` (process.env)

### `AUTH_OAUTH_STATE_TTL`

- **Templates**:
  - `backend/env.example:61` = `600`
- **Code references**:
  - `backend/routes/auth.js:L136` (process.env)

### `AUTH_PHONE_CODE_TTL`

- **Templates**:
  - `backend/env.example:59` = `600`
- **Code references**:
  - `backend/routes/auth.js:L134` (process.env)

### `AUTH_PHONE_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L207` (process.env)

### `AUTH_PHONE_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:60` = `60`
- **Code references**:
  - `backend/routes/auth.js:L135` (process.env)

### `AUTH_PUBLIC_URL`

- **Templates**:
  - `backend/env.example:63` = `http://localhost:5173/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L153` (process.env)
  - `backend/services/diagnosticsService.js:L236` (process.env)

### `AUTH_REFRESH_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:56` = `2592000`
- **Code references**:
  - `backend/routes/auth.js:L131` (process.env)

### `AUTH_YAHOO_CLIENT_ID`

- **Templates**:
  - `backend/env.example:137` = `yahoo-client-id`
- **Code references**: (none)

### `AUTH_YAHOO_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:138` = `yahoo-client-secret`
- **Code references**: (none)

### `BACKEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L21` (process.env)

### `BASELINE_SEED_MODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L550` (process.env)

### `BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `repo/src/App.jsx:L74` (import.meta.env)
  - `scripts/run-all-real-crawlers.mjs:L4` (process.env)
  - `src/config/env.js:L25` (import.meta.env)

### `BUILD_TIMESTAMP`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1176` (process.env)
  - `repo/backend/server.js:L996` (process.env)

### `BULK_POPULATE_KEY`

- **Templates**:
  - `backend/env.example:33` = ``
- **Code references**:
  - `backend/routes/crawlerV2.js:L9` (process.env)
  - `backend/routes/crawlers.js:L1302–L2007` (process.env)
  - `backend/server.js:L760–L968` (process.env)
  - `repo/backend/server.js:L636–L820` (process.env)

### `CI`

- **Templates**: (not present)
- **Code references**:
  - `tests/smoke/playwright.config.mjs:L12–L13` (process.env)

### `COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1165` (process.env)
  - `repo/backend/server.js:L985` (process.env)

### `CONFIRM`

- **Templates**: (not present)
- **Code references**:
  - `scripts/godaddy-set-vercel-dns.mjs:L93` (process.env)

### `CORS_ORIGIN`

- **Templates**:
  - `backend/env.example:41` = `http://localhost:5173,http://127.0.0.1:5173`
- **Code references**:
  - `backend/server.js:L110–L111` (process.env)
  - `repo/backend/server.js:L87–L88` (process.env)
  - `scripts/doctor.mjs:L78` (process.env)
  - `tests/unit/anya-tasks.test.mjs:L70` (process.env)
  - `tests/unit/api-contracts.test.mjs:L73` (process.env)

### `CRAWLER_MAX_SOURCES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-doctor.mjs:L134` (process.env)
  - `scripts/crawler-run.mjs:L25` (process.env)
  - `scripts/crawler-smoke.mjs:L61` (process.env)

### `CRAWLER_MAX_URLS_PER_SOURCE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L26` (process.env)
  - `scripts/crawler-smoke.mjs:L62` (process.env)

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

### `CRAWLER_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-live-crawlers-all-profiles.mjs:L32` (process.env)

### `CRAWLER_TIMEOUT_SECONDS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L27` (process.env)
  - `scripts/crawler-smoke.mjs:L63` (process.env)

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
  - `backend/db/index.js:L17` (process.env)
  - `backend/import-data.js:L24` (process.env)
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L314` (process.env)
  - `repo/backend/db/index.js:L30–L358` (process.env)
  - `scripts/crawler-doctor.mjs:L18` (process.env)
  - `scripts/crawler-run.mjs:L19` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L20` (process.env)
  - `scripts/run-live-crawlers-all-profiles.mjs:L30` (process.env)

### `DB_AUTO_MIGRATE`

- **Templates**:
  - `backend/env.example:22` = `false`
- **Code references**:
  - `backend/server.js:L332` (process.env)
  - `repo/backend/server.js:L214` (process.env)

### `DB_DIALECT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L56` (process.env)
  - `repo/backend/db/index.js:L27` (process.env)

### `DB_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L63–L235` (process.env)
  - `backend/tests/crawlerMatrixTest.js:L26` (process.env)
  - `scripts/build-seed-db.mjs:L41` (process.env)
  - `scripts/check-profiles.mjs:L45–L46` (process.env)
  - `scripts/crawler-smoke.mjs:L17` (process.env)
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
  - `backend/db/index.js:L55` (process.env)
  - `repo/backend/db/index.js:L26` (process.env)

### `DEV`

- **Templates**: (not present)
- **Code references**:
  - `repo/src/api/client.js:L9–L15` (import.meta.env)
  - `repo/src/components/auth/AuthErrorBoundary.jsx:L84` (import.meta.env)
  - `repo/src/components/shared/ErrorBoundary.jsx:L16` (import.meta.env)
  - `src/api/auth.js:L4–L11` (import.meta.env)
  - `src/api/client.js:L15` (import.meta.env)
  - `src/components/auth/AuthErrorBoundary.jsx:L84` (import.meta.env)
  - `src/components/shared/ErrorBoundary.jsx:L16` (import.meta.env)
  - `src/config/env.js:L23` (import.meta.env)

### `ENABLE_ASSISTANCE_DIRECTORIES_SEED`

- **Templates**:
  - `backend/env.example:28` = `false`
- **Code references**:
  - `repo/backend/server.js:L553` (process.env)

### `ENABLE_MIN_NATIONAL_ENSURE`

- **Templates**:
  - `backend/env.example:27` = `false`
- **Code references**:
  - `backend/server.js:L618` (process.env)
  - `repo/backend/server.js:L491` (process.env)

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
  - `backend/env.example:82` = `noreply@yourdomain.com`
- **Code references**:
  - `backend/services/diagnosticsService.js:L230` (process.env)
  - `backend/services/email.js:L9` (process.env)

### `FRONTEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L154` (process.env)
  - `backend/services/diagnosticsService.js:L237` (process.env)

### `FUNDING_APIS_REQUIRE_KEYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/src/config/apiKeys.js:L71` (process.env)

### `GEO_COUNTIES_BY_STATE_PATH`

- **Templates**:
  - `backend/env.example:50` = ``
- **Code references**:
  - `backend/routes/admin.js:L50–L51` (process.env)

### `GEO_ZIP_COORDINATES_PATH`

- **Templates**:
  - `backend/env.example:49` = ``
- **Code references**:
  - `backend/routes/admin.js:L47–L48` (process.env)

### `GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1164` (process.env)
  - `repo/backend/server.js:L984` (process.env)

### `GOOGLE_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L70` (process.env)
  - `repo/backend/services/countyFundingCrawler.js:L70` (process.env)

### `GOOGLE_SEARCH_CX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L71` (process.env)
  - `repo/backend/services/countyFundingCrawler.js:L71` (process.env)

### `GRANTS_GOV_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L224` (process.env)

### `JWT_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L40` (process.env)
  - `backend/server.js:L711–L964` (process.env)
  - `backend/utils/runtimeSecrets.js:L20` (process.env)
  - `repo/backend/server.js:L592–L816` (process.env)

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
  - `backend/env.example:141` = `debug`
- **Code references**: (none)

### `MAX_PROFILES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-live-crawlers-all-profiles.mjs:L33` (process.env)

### `MIGRATE_ASSERT_FRESH`

- **Templates**: (not present)
- **Code references**:
  - `backend/start.js:L88–L88` (process.env)

### `MIGRATE_VERIFY_COUNTS`

- **Templates**: (not present)
- **Code references**:
  - `backend/start.js:L89–L89` (process.env)

### `MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/realCrawlers.js:L33` (process.env)

### `MIN_NATIONAL_OPPORTUNITIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L614` (process.env)
  - `repo/backend/server.js:L487` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L132` (process.env)

### `MIN_NATIONAL_VISIBLE`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L246` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L79` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1476` (process.env)
  - `repo/backend/server.js:L1227` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1478` (process.env)
  - `repo/backend/server.js:L1229` (process.env)

### `NATIONAL_PROGRAMS_MAX_DEPTH`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1482` (process.env)
  - `repo/backend/server.js:L1233` (process.env)

### `NATIONAL_PROGRAMS_MAX_URLS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1481` (process.env)
  - `repo/backend/server.js:L1232` (process.env)

### `NODE_ENV`

- **Templates**:
  - `backend/env.example:5` = `development`
- **Code references**:
  - `backend/config/env.js:L78–L176` (process.env)
  - `backend/db/index.js:L64` (process.env)
  - `backend/middleware/errorHandler.js:L13` (process.env)
  - `backend/routes/anya.js:L47–L117` (process.env)
  - `backend/routes/auth.js:L41–L2224` (process.env)
  - `backend/routes/reminders.js:L188–L213` (process.env)
  - `backend/server.js:L63–L1443` (process.env)
  - `backend/services/anyaTestRepair.js:L155` (process.env)
  - `backend/services/diagnosticsService.js:L30–L234` (process.env)
  - `backend/services/email.js:L15` (process.env)
  - `backend/services/mockAI.js:L9` (process.env)
  - `backend/src/config/apiKeys.js:L100` (process.env)
  - `repo/backend/config/env.js:L70–L168` (process.env)
  - `repo/backend/db/index.js:L35` (process.env)
  - `repo/backend/server.js:L215–L1194` (process.env)
  - `scripts/build-seed-db.mjs:L15` (process.env)
  - `scripts/seed-profiles.mjs:L28` (process.env)

### `OPENAI_API_KEY`

- **Templates**:
  - `backend/env.example:75` = `sk-your-openai-key`
- **Code references**:
  - `backend/routes/admin.js:L348–L440` (process.env)
  - `backend/routes/anya.js:L115` (process.env)
  - `backend/routes/auth.js:L31` (process.env)
  - `backend/scripts/create-profile-from-pdf.mjs:L74` (process.env)
  - `backend/scripts/dispatch-crawlers.mjs:L9` (process.env)
  - `backend/scripts/fix-anastasia-profile.mjs:L9` (process.env)
  - `backend/scripts/process-all-jobs.mjs:L9` (process.env)
  - `backend/scripts/process-anastasia-ai.mjs:L6` (process.env)
  - `backend/scripts/process-queue.mjs:L10` (process.env)
  - `backend/scripts/read-anastasia-vision.mjs:L5` (process.env)
  - `backend/server.js:L352–L951` (process.env)
  - `backend/services/anyaToolRegistry.js:L752` (process.env)
  - `backend/services/diagnosticsService.js:L227` (process.env)
  - `backend/utils/openaiClient.js:L29–L55` (process.env)
  - `repo/backend/server.js:L236–L804` (process.env)
  - `scripts/fix-api-errors.mjs:L25–L27` (process.env)

### `OPENAI_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L78` (process.env)

### `OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/constants.js:L52` (process.env)
  - `backend/routes/admin.js:L36` (process.env)
  - `backend/routes/profiles.js:L811–L934` (process.env)
  - `backend/services/pipelineAutomation.js:L286` (process.env)
  - `backend/services/profileEnrichment.js:L165` (process.env)
  - `repo/backend/routes/profiles.js:L784` (process.env)

### `OPENAI_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L73` (process.env)

### `PDF_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/read-anastasia-vision.mjs:L6` (process.env)

### `PGDATABASE`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L25` (process.env)

### `PGHOST`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L21` (process.env)

### `PGPASSWORD`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L24` (process.env)

### `PGPORT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L22` (process.env)

### `PGSSLMODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L26` (process.env)

### `PGUSER`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L23` (process.env)

### `PG_POOL_CONN_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L407` (process.env)
  - `repo/backend/db/index.js:L279` (process.env)

### `PG_POOL_IDLE_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L406` (process.env)
  - `repo/backend/db/index.js:L278` (process.env)

### `PG_POOL_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L405` (process.env)
  - `repo/backend/db/index.js:L277` (process.env)

### `PORT`

- **Templates**:
  - `backend/env.example:4` = `8080`
- **Code references**:
  - `backend/server.js:L99` (process.env)
  - `repo/backend/server.js:L66–L74` (process.env)

### `POSTGRES_DB`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L25` (process.env)

### `POSTGRES_HOST`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L21` (process.env)

### `POSTGRES_PASSWORD`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L24` (process.env)

### `POSTGRES_PORT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L22` (process.env)

### `POSTGRES_USER`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L23` (process.env)

### `PROD`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L24` (import.meta.env)
  - `src/utils/enforceCanonicalHost.js:L4` (import.meta.env)

### `PUBLIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L153` (process.env)
  - `backend/services/diagnosticsService.js:L236` (process.env)

### `RAILWAY_DEPLOYMENT_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L75` (process.env)

### `RAILWAY_DEPLOYMENT_START_TIME`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1177` (process.env)
  - `repo/backend/server.js:L997` (process.env)

### `RAILWAY_ENVIRONMENT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L48–L72` (process.env)

### `RAILWAY_GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L74` (process.env)
  - `backend/server.js:L1163` (process.env)
  - `repo/backend/server.js:L983` (process.env)

### `RAILWAY_PROJECT_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L49–L70` (process.env)

### `RAILWAY_SERVICE_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L50–L71` (process.env)

### `RAILWAY_STATIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L73` (process.env)

### `REQUEST_ID_ERROR_STORE_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/requestIdErrorStore.js:L1` (process.env)

### `REQUEST_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L168` (process.env)
  - `repo/backend/server.js:L146` (process.env)

### `RESEND_API_KEY`

- **Templates**:
  - `backend/env.example:81` = `re_your-resend-key`
- **Code references**:
  - `backend/services/diagnosticsService.js:L229` (process.env)
  - `backend/services/email.js:L8` (process.env)

### `RUNTIME_SECRETS_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/runtimeSecrets.js:L4` (process.env)

### `RUN_SQLITE_MIGRATION`

- **Templates**: (not present)
- **Code references**:
  - `backend/start.js:L74` (process.env)

### `SAM_GOV_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaToolRegistry.js:L753` (process.env)
  - `backend/services/connectors/samGovConnector.js:L61–L118` (process.env)
  - `backend/services/diagnosticsService.js:L223` (process.env)
  - `tests/unit/funding-api-keys.test.mjs:L32–L37` (process.env)

### `SAM_GOV_PUBLIC_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L223` (process.env)
  - `tests/unit/funding-api-keys.test.mjs:L31–L36` (process.env)

### `SEED_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L1382` (process.env)

### `SEED_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/seed-profiles.mjs:L51–L52` (process.env)

### `SENTRY_DSN`

- **Templates**:
  - `backend/env.example:142` = ``
- **Code references**: (none)

### `SERVICE_APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/serviceApplication.js:L8` (process.env)

### `SESSION_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/runtimeSecrets.js:L21` (process.env)

### `SIMPLER_GRANTS_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L225` (process.env)
  - `tests/unit/funding-api-keys.test.mjs:L11–L35` (process.env)

### `SMOKE_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L180` (process.env)

### `SMOKE_API_BASE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-docs-local.mjs:L18` (process.env)

### `SMOKE_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L178` (process.env)
  - `scripts/smoke-auth-callback.mjs:L49` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L51` (process.env)
  - `scripts/smoke-login.mjs:L29` (process.env)
  - `scripts/smoke-organization-profile.mjs:L51` (process.env)
  - `scripts/smoke-prod-readonly.mjs:L14` (process.env)
  - `tests/smoke/playwright.config.mjs:L5` (process.env)

### `SMOKE_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L20` (process.env)
  - `scripts/smoke-auth-callback.mjs:L17` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L19` (process.env)
  - `scripts/smoke-login.mjs:L16` (process.env)
  - `scripts/smoke-organization-profile.mjs:L19` (process.env)
  - `scripts/smoke-prod-readonly.mjs:L13` (process.env)
  - `tests/smoke/playwright.config.mjs:L4` (process.env)

### `SMOKE_CHECK_PROFILE_SCHEMA`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-prod-readonly.mjs:L15` (process.env)

### `SMOKE_DEBUG`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-login.mjs:L58–L72` (process.env)

### `SMOKE_MAX_CLICKS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L184` (process.env)

### `SMOKE_MAX_PER_SELECTOR`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L185` (process.env)

### `SMOKE_MAX_ROUTES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L183` (process.env)

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
  - `backend/env.example:11` = `backend/data/grantflow.dev.db`
- **Code references**:
  - `backend/db/index.js:L85` (process.env)
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L312` (process.env)
  - `backend/start.js:L17` (process.env)
  - `repo/backend/db/index.js:L44` (process.env)
  - `scripts/crawler-smoke.mjs:L18` (process.env)

### `TEST_STATE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/opportunities-national-minimum.mjs:L133` (process.env)

### `TWILIO_ACCOUNT_SID`

- **Templates**:
  - `backend/env.example:68` = `ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L148` (process.env)
  - `backend/services/diagnosticsService.js:L238` (process.env)

### `TWILIO_AUTH_TOKEN`

- **Templates**:
  - `backend/env.example:69` = `your-twilio-auth-token`
- **Code references**:
  - `backend/routes/auth.js:L149` (process.env)
  - `backend/services/diagnosticsService.js:L238` (process.env)

### `TWILIO_FROM_NUMBER`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L151` (process.env)

### `TWILIO_MESSAGING_SERVICE_SID`

- **Templates**:
  - `backend/env.example:70` = `MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L150` (process.env)

### `UPLOADS_DIR`

- **Templates**:
  - `backend/env.example:39` = ``
- **Code references**:
  - `backend/routes/admin.js:L41–L42` (process.env)
  - `backend/routes/documents.js:L28–L29` (process.env)
  - `backend/routes/profiles.js:L55–L56` (process.env)
  - `backend/server.js:L90–L91` (process.env)
  - `tests/unit/release-hardening.test.mjs:L30–L31` (process.env)

### `VERCEL_GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1166` (process.env)
  - `repo/backend/server.js:L986` (process.env)

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
  - `env.example:8` = `http://localhost:8080`
- **Code references**: (none)

### `VITE_API_URL`

- **Templates**:
  - `env.example:4` = `http://localhost:8080`
- **Code references**:
  - `repo/src/api/client.js:L10–L20` (import.meta.env)
  - `src/api/client.js:L16–L20` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L35–L63` (import.meta.env)
  - `src/config/env.js:L27` (import.meta.env)

### `VITE_APP_BASE`

- **Templates**:
  - `env.example:5` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L156` (process.env)
  - `backend/server.js:L293` (process.env)
  - `repo/backend/server.js:L192` (process.env)
  - `repo/src/App.jsx:L74` (import.meta.env)
  - `repo/src/api/client.js:L12` (import.meta.env)
  - `scripts/doctor.mjs:L79–L178` (process.env)
  - `src/components/auth/SessionExpiredDialog.jsx:L10` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L24` (import.meta.env)
  - `src/config/env.js:L26` (import.meta.env)
  - `tests/smoke/playwright.config.mjs:L5` (process.env)
  - `tests/unit/anya-tasks.test.mjs:L71` (process.env)
  - `tests/unit/api-contracts.test.mjs:L74` (process.env)

### `VITE_ASSET_BASE`

- **Templates**:
  - `env.example:11` = `/grantflow/`
- **Code references**:
  - `scripts/doctor.mjs:L167` (process.env)

### `VITE_CANONICAL_HOST`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L28` (import.meta.env)
  - `src/utils/enforceCanonicalHost.js:L6` (import.meta.env)

### `VITE_CANONICAL_HOST_STRICT`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L29` (import.meta.env)
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

### `X_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-docs-local.mjs:L19` (process.env)
