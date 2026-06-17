# ENV Vars Inventory

This file is **generated** by `node scripts/inventory-env.mjs`.
It enumerates environment variables referenced in code and/or present in example env files.

## Summary

- Total vars: **373**
- Vars referenced in code: **358**
- Vars present in env templates: **75**

## Inventory

| Name | Referenced in code | Defined in templates | Notes |
| --- | --- | --- | --- |
| `ACCESS_TOKEN` | Yes | No | Backend/Node |
| `ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `ADMIN_EMAILS` | Yes | No | Backend/Node |
| `ADMIN_HEALTH_TOKEN` | Yes | No | Backend/Node |
| `ADMIN_LOGIN_EVENT_BUFFER` | Yes | No | Backend/Node |
| `ADMIN_NAME` | Yes | Yes | Backend/Node |
| `ADMIN_PHONE` | Yes | No | Backend/Node |
| `ADMIN_SELF_BASE_URL` | Yes | No | Backend/Node |
| `ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ALERT_FAILURE_THRESHOLD` | Yes | No | Backend/Node |
| `ALERT_QUEUE_BACKLOG_THRESHOLD` | Yes | No | Backend/Node |
| `ALLOW_ANYA_TEST_REPAIR_MUTATIONS` | Yes | No | Backend/Node |
| `ALLOW_AUTO_ROUTE_GENERATION` | Yes | No | Backend/Node |
| `ALLOW_DESTRUCTIVE_SEED` | Yes | No | Backend/Node |
| `ALLOW_DEV_FILESYSTEM_AUDIT_LOGS` | Yes | No | Backend/Node |
| `ALLOW_EPHEMERAL_SQLITE` | Yes | No | Backend/Node |
| `ALLOW_EPHEMERAL_UPLOADS` | Yes | No | Backend/Node |
| `ALLOW_LEGACY_PROFILE_TOKEN` | Yes | Yes | Backend/Node |
| `ALLOW_SQLITE_IN_PROD` | Yes | No | Backend/Node |
| `ANALYTICS_WRITE_KEY` | No | Yes |  |
| `ANTHROPIC_API_KEY` | Yes | Yes | Backend/Node |
| `ANTHROPIC_MAX_RETRIES` | Yes | No | Backend/Node |
| `ANTHROPIC_MODEL` | Yes | No | Backend/Node |
| `ANTHROPIC_MODEL_SCHOOL_LOOKUP` | Yes | No | Backend/Node |
| `ANTHROPIC_TIMEOUT_MS` | Yes | No | Backend/Node |
| `ANYA_ADMIN_GEO_COOLDOWN_HOURS` | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_GEO_ON_LOGIN` | No | Yes |  |
| `ANYA_ADMIN_GEO_OVERPASS_MAX` | Yes | No | Backend/Node |
| `ANYA_ADMIN_GEO_OVERPASS_RADIUS_KM` | Yes | No | Backend/Node |
| `ANYA_ADMIN_GEO_SKIP_DOMAIN_CORPUS` | No | Yes |  |
| `ANYA_ADMIN_GEO_STATE_PACING_MS` | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ANYA_ALLOW_CODE_EDIT` | Yes | No | Backend/Node |
| `ANYA_ANTHROPIC_COOLDOWN_MS` | Yes | No | Backend/Node |
| `ANYA_ANTHROPIC_FAILURE_THRESHOLD` | Yes | No | Backend/Node |
| `ANYA_ANTHROPIC_MAX_RETRIES` | Yes | No | Backend/Node |
| `ANYA_ANTHROPIC_TIMEOUT_MS` | Yes | No | Backend/Node |
| `ANYA_API_KEY` | Yes | No | Backend/Node |
| `ANYA_AUTONOMOUS_ENABLED` | Yes | Yes | Backend/Node |
| `ANYA_AUTONOMOUS_WRITES` | Yes | Yes | Backend/Node |
| `ANYA_AUTONOMOUS_WRITE_CHANGES` | Yes | Yes | Backend/Node |
| `ANYA_AUTO_REPAIR` | Yes | No | Backend/Node |
| `ANYA_CODE_CRAWL` | Yes | Yes | Backend/Node |
| `ANYA_CRAWLERS` | Yes | Yes | Backend/Node |
| `ANYA_DRY_RUN` | Yes | Yes | Backend/Node |
| `ANYA_FIX_CONSOLE` | Yes | Yes | Backend/Node |
| `ANYA_FIX_EMPTY_CATCH` | Yes | Yes | Backend/Node |
| `ANYA_FIX_ERRORS` | Yes | Yes | Backend/Node |
| `ANYA_FUNCTION_TESTS` | Yes | Yes | Backend/Node |
| `ANYA_FUNCTION_TEST_TIMEOUT_MS` | Yes | No | Backend/Node |
| `ANYA_GEO_CRAWL` | Yes | No | Backend/Node |
| `ANYA_HEALTH_INTERVAL_MS` | Yes | No | Backend/Node |
| `ANYA_ITEM_DISCOVERY` | Yes | No | Backend/Node |
| `ANYA_ITEM_DISCOVERY_LIMIT` | Yes | No | Backend/Node |
| `ANYA_ITEM_DISCOVERY_MIN_COUNT` | Yes | No | Backend/Node |
| `ANYA_MATCH_THRESHOLD` | No | Yes |  |
| `ANYA_MAX_FILE_CHANGES` | Yes | Yes | Backend/Node |
| `ANYA_OPENAI_COOLDOWN_MS` | Yes | No | Backend/Node |
| `ANYA_OPENAI_FAILURE_THRESHOLD` | Yes | No | Backend/Node |
| `ANYA_OPENAI_MAX_RETRIES` | Yes | No | Backend/Node |
| `ANYA_OPENAI_MODEL` | Yes | No | Backend/Node |
| `ANYA_OPENAI_TIMEOUT_MS` | Yes | No | Backend/Node |
| `ANYA_PORTAL_CHECKS` | Yes | No | Backend/Node |
| `ANYA_RUN_ON_ADMIN_LOGIN` | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `ANYA_SAVE_GLOBAL` | Yes | Yes | Backend/Node |
| `ANYA_SCHEDULE` | Yes | Yes | Backend/Node |
| `ANYA_SELF_BASE_URL` | Yes | No | Backend/Node |
| `ANYA_USAGE_RETENTION_DAYS` | Yes | No | Backend/Node |
| `ANYA_WAIT_COMPLETION` | Yes | Yes | Backend/Node |
| `API_BASE` | Yes | No | Backend/Node |
| `API_BASE_URL` | Yes | No | Backend/Node |
| `API_DATA_GOV_KEY` | Yes | No | Backend/Node |
| `API_URL` | Yes | No | Backend/Node |
| `APPLICATION_EMAIL` | Yes | No | Backend/Node |
| `APPLY` | Yes | No | Backend/Node |
| `APPLY_STORAGE_DIR` | Yes | No | Backend/Node |
| `APP_BASE_PATH` | Yes | No | Backend/Node |
| `AUTH_ACCESS_TOKEN_TTL` | Yes | Yes | Backend/Node |
| `AUTH_ALLOW_ADMIN_PREVIEW_CODE` | No | Yes |  |
| `AUTH_ALLOW_PREVIEW_CODE_IN_PROD` | No | Yes |  |
| `AUTH_EMAIL_CODE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_RATE_LIMIT` | Yes | No | Backend/Node |
| `AUTH_EMAIL_RESEND_SECONDS` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_SEND_TIMEOUT_MS` | Yes | No | Backend/Node |
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
| `AUTH_PASSWORD_RATE_LIMIT` | Yes | No | Backend/Node |
| `AUTH_PASSWORD_SETUP_TTL` | Yes | No | Backend/Node |
| `AUTH_PHONE_CODE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_RATE_LIMIT` | Yes | No | Backend/Node |
| `AUTH_PHONE_RESEND_SECONDS` | Yes | Yes | Backend/Node |
| `AUTH_PUBLIC_URL` | Yes | Yes | Backend/Node |
| `AUTH_REFRESH_TOKEN_TTL` | Yes | Yes | Backend/Node |
| `AUTH_TOKEN` | Yes | No | Backend/Node |
| `AUTH_YAHOO_CLIENT_ID` | No | Yes |  |
| `AUTH_YAHOO_CLIENT_SECRET` | No | Yes |  |
| `AUTO_POPULATE_PER_SECTION_TIMEOUT_MS` | Yes | No | Backend/Node |
| `AUTO_POPULATE_TOTAL_BUDGET_MS` | Yes | No | Backend/Node |
| `AWS_ACCESS_KEY_ID` | Yes | No | Backend/Node |
| `AWS_REGION` | Yes | No | Backend/Node |
| `AWS_SESSION_TOKEN` | Yes | No | Backend/Node |
| `BACKEND_BASE_URL` | Yes | No | Backend/Node |
| `BACKEND_PORT` | Yes | No | Backend/Node |
| `BASELINE_SEED_MODE` | Yes | No | Backend/Node |
| `BASE_URL` | Yes | No | Used in both backend + frontend |
| `BEARER_TOKEN` | Yes | No | Backend/Node |
| `BUILD_TIME` | Yes | No | Backend/Node |
| `BUILD_TIMESTAMP` | Yes | No | Backend/Node |
| `BULK_POPULATE_KEY` | Yes | Yes | Backend/Node |
| `CI` | Yes | No | Backend/Node |
| `COMMIT_AUDIT_OUT_PATH` | Yes | No | Backend/Node |
| `COMMIT_SHA` | Yes | No | Backend/Node |
| `COMPREHENSIVE_GEO_JOB_TIMEOUT_MS` | Yes | No | Backend/Node |
| `COMPREHENSIVE_JOB_TIMEOUT_MS` | Yes | No | Backend/Node |
| `CONFIRM` | Yes | No | Backend/Node |
| `CORE_TIMEOUT_MINUTES` | Yes | No | Backend/Node |
| `CORS_ORIGIN` | Yes | Yes | Backend/Node |
| `CRAWLER_DATA_DIR` | Yes | No | Backend/Node |
| `CRAWLER_DISPATCH_BASE_DELAY_MS` | Yes | No | Backend/Node |
| `CRAWLER_DISPATCH_MAX_ATTEMPTS` | Yes | No | Backend/Node |
| `CRAWLER_DISPATCH_MAX_DELAY_MS` | Yes | No | Backend/Node |
| `CRAWLER_JOB_STUCK_THRESHOLD_MS` | Yes | No | Backend/Node |
| `CRAWLER_JOB_TIMEOUT_MS` | Yes | No | Backend/Node |
| `CRAWLER_MAX_CONCURRENCY` | Yes | No | Backend/Node |
| `CRAWLER_MAX_RETRY_DELAY` | Yes | No | Backend/Node |
| `CRAWLER_MAX_SOURCES` | Yes | No | Backend/Node |
| `CRAWLER_MAX_URLS_PER_SOURCE` | Yes | No | Backend/Node |
| `CRAWLER_MODE` | Yes | No | Backend/Node |
| `CRAWLER_RETRY_BASE_DELAY` | Yes | No | Backend/Node |
| `CRAWLER_STALE_CLEANUP_INTERVAL_MS` | Yes | No | Backend/Node |
| `CRAWLER_STALE_DAYS` | Yes | No | Backend/Node |
| `CRAWLER_STALE_RUNNING_MS` | Yes | No | Backend/Node |
| `CRAWLER_STATE` | Yes | No | Backend/Node |
| `CRAWLER_TIMEOUT_SECONDS` | Yes | No | Backend/Node |
| `CRAWLER_USE_LIVE_SOURCES` | Yes | No | Backend/Node |
| `DATABASE_PATH` | Yes | No | Backend/Node |
| `DATABASE_PUBLIC_URL` | Yes | No | Backend/Node |
| `DATABASE_URL` | Yes | No | Backend/Node |
| `DB_AUTO_MIGRATE` | Yes | Yes | Backend/Node |
| `DB_DIALECT` | Yes | No | Backend/Node |
| `DB_PATH` | Yes | No | Backend/Node |
| `DB_POOL_MAX` | Yes | No | Backend/Node |
| `DB_PROVIDER` | Yes | Yes | Backend/Node |
| `DEDUPE_BASE_URL` | Yes | No | Backend/Node |
| `DEPLOY_ENV` | Yes | No | Backend/Node |
| `DEPLOY_TIMESTAMP` | Yes | No | Backend/Node |
| `DEV` | Yes | No | Frontend (Vite) |
| `DISABLE_SEEDING` | Yes | No | Backend/Node |
| `DOMAIN_CORPUS_CRAWL_TIMEOUT_MS` | Yes | No | Backend/Node |
| `DRY_RUN` | Yes | No | Backend/Node |
| `E2E_BASE_PATH` | Yes | No | Backend/Node |
| `E2E_BASE_URL` | Yes | No | Backend/Node |
| `E2E_PORT` | Yes | No | Backend/Node |
| `EMAIL_FROM` | Yes | No | Backend/Node |
| `ENABLE_ASSISTANCE_DIRECTORIES_SEED` | No | Yes |  |
| `ENABLE_MIN_NATIONAL_ENSURE` | Yes | Yes | Backend/Node |
| `FEATURE_ANYA_TOOLS` | Yes | No | Backend/Node |
| `FEATURE_AUTO_REPAIR` | Yes | No | Backend/Node |
| `FEATURE_CRAWLER_RETRIES` | Yes | No | Backend/Node |
| `FEATURE_DETAILED_MATCHING` | Yes | No | Backend/Node |
| `FEATURE_GEO_CRAWL` | Yes | No | Backend/Node |
| `FROM_EMAIL` | Yes | Yes | Backend/Node |
| `FRONTEND_BASE_URL` | Yes | No | Backend/Node |
| `FRONTEND_COMPONENTS_PATH` | Yes | No | Backend/Node |
| `FUNDING_APIS_REQUIRE_KEYS` | Yes | No | Backend/Node |
| `GEO_BATCH_SIZE` | Yes | No | Backend/Node |
| `GEO_COUNTIES_BY_STATE_PATH` | Yes | Yes | Backend/Node |
| `GEO_CRAWL_FIXTURES_DIR` | Yes | No | Backend/Node |
| `GEO_MIN_SOURCES_PER_ZIP` | Yes | No | Backend/Node |
| `GEO_MIN_ZIP_COORDINATES` | Yes | No | Backend/Node |
| `GEO_RATE_LIMIT_MS` | Yes | No | Backend/Node |
| `GEO_SCOPE` | Yes | No | Backend/Node |
| `GEO_TIMEOUT_MS` | Yes | No | Backend/Node |
| `GEO_ZIP_COORDINATES_PATH` | Yes | Yes | Backend/Node |
| `GITHUB_ACTIONS` | Yes | No | Backend/Node |
| `GITHUB_REPO` | Yes | No | Backend/Node |
| `GITHUB_TOKEN` | Yes | No | Backend/Node |
| `GIT_BRANCH` | Yes | No | Backend/Node |
| `GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `GOOGLE_API_KEY` | Yes | No | Backend/Node |
| `GOOGLE_SEARCH_CX` | Yes | No | Backend/Node |
| `GRANTFLOW_BASE_URL` | Yes | No | Backend/Node |
| `GRANTFLOW_BEARER_TOKEN` | Yes | No | Backend/Node |
| `GRANTFLOW_DRY_RUN` | Yes | No | Backend/Node |
| `GRANTFLOW_PROFILE_ID` | Yes | No | Backend/Node |
| `GRANTFLOW_PROFILE_IDS` | Yes | No | Backend/Node |
| `GRANTFLOW_REPO_ROOT` | Yes | No | Backend/Node |
| `GRANTFLOW_SEED_MODE` | Yes | No | Backend/Node |
| `GRANTFLOW_SKIP_VERIFICATION_GATE` | Yes | No | Backend/Node |
| `GRANTFLOW_TEST_EMAIL` | Yes | No | Backend/Node |
| `GRANTFLOW_TEST_PASSWORD` | Yes | No | Backend/Node |
| `GRANTFLOW_TIMEOUT_MS` | Yes | No | Backend/Node |
| `GRANTFLOW_TOKEN` | Yes | No | Backend/Node |
| `GRANTS_GOV_API_KEY` | Yes | No | Backend/Node |
| `HOURS_LOOKBACK` | Yes | No | Backend/Node |
| `INTERNAL_API_URL` | Yes | No | Backend/Node |
| `ITEM_SUGGESTIONS_PER_PROFILE` | Yes | No | Backend/Node |
| `JWT_SECRET` | Yes | No | Backend/Node |
| `LEGACY_GRANT_ONLY_EXCLUDES_MATCHING` | Yes | No | Backend/Node |
| `LIMIT` | Yes | No | Backend/Node |
| `LIMIT_OPPS_PER_PROFILE` | Yes | No | Backend/Node |
| `LINK_VERIFICATION_BATCH` | Yes | No | Backend/Node |
| `LINK_VERIFICATION_INTERVAL_MS` | Yes | No | Backend/Node |
| `LOG_BUFFER_SIZE` | Yes | No | Backend/Node |
| `LOG_LEVEL` | Yes | Yes | Backend/Node |
| `MAIN_DB_PATH` | Yes | No | Backend/Node |
| `MATCHING_ENGINE_FACET_DEBUG` | Yes | No | Backend/Node |
| `MATCH_THRESHOLD` | Yes | No | Backend/Node |
| `MAX_CONCURRENT_CRAWLERS` | Yes | No | Backend/Node |
| `MAX_CRAWLER_RETRIES` | Yes | No | Backend/Node |
| `MAX_EXPORT_ROWS` | Yes | No | Backend/Node |
| `MAX_LIMIT` | Yes | No | Backend/Node |
| `MAX_ORPHAN_AUTO_RETRIES` | Yes | No | Backend/Node |
| `MAX_ZIPS` | Yes | No | Backend/Node |
| `MIGRATE_ASSERT_FRESH` | Yes | No | Backend/Node |
| `MIGRATE_ON_BOOT` | Yes | No | Backend/Node |
| `MIGRATE_VERIFY_COUNTS` | Yes | No | Backend/Node |
| `MIN_NATIONAL_OPPORTUNITIES` | Yes | No | Backend/Node |
| `MIN_NATIONAL_VISIBLE` | Yes | No | Backend/Node |
| `MODE` | Yes | No | Frontend (Vite) |
| `NATIONAL_PROGRAMS_CRAWLER_ENABLED` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_DEPTH` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_URLS` | Yes | No | Backend/Node |
| `NIH_LIMIT` | Yes | No | Backend/Node |
| `NIH_TEXT` | Yes | No | Backend/Node |
| `NODE_ENV` | Yes | Yes | Backend/Node |
| `NOFO_FETCH_TIMEOUT_MS` | Yes | No | Backend/Node |
| `NOFO_PARSE_MAX_TEXT_CHARS` | Yes | No | Backend/Node |
| `OCR_PDF_DPI` | Yes | No | Backend/Node |
| `OCR_PDF_MAX_PAGES` | Yes | No | Backend/Node |
| `OCR_PROVIDER` | Yes | No | Backend/Node |
| `OPENAI_API_KEY` | Yes | Yes | Backend/Node |
| `OPENAI_MAX_RETRIES` | Yes | No | Backend/Node |
| `OPENAI_MODEL` | Yes | No | Backend/Node |
| `OPENAI_TIMEOUT_MS` | Yes | No | Backend/Node |
| `OPPORTUNITY_INSERT_VERIFY_URL` | Yes | No | Backend/Node |
| `OPPORTUNITY_MIN_COUNT` | Yes | No | Backend/Node |
| `OPPORTUNITY_STALE_DAYS` | Yes | No | Backend/Node |
| `ORPHAN_MAINTENANCE_CONFIRM` | Yes | No | Backend/Node |
| `OWNER_EMAIL` | Yes | No | Backend/Node |
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
| `PG_STATEMENT_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PIPELINE_JOB_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PIPELINE_SLOW_MS` | Yes | No | Backend/Node |
| `PIPELINE_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PORT` | Yes | Yes | Backend/Node |
| `POSTGRES_DB` | Yes | No | Backend/Node |
| `POSTGRES_HOST` | Yes | No | Backend/Node |
| `POSTGRES_PASSWORD` | Yes | No | Backend/Node |
| `POSTGRES_PORT` | Yes | No | Backend/Node |
| `POSTGRES_USER` | Yes | No | Backend/Node |
| `PREVIEW_PORT` | Yes | No | Backend/Node |
| `PROD` | Yes | No | Frontend (Vite) |
| `PROFILE_ID` | Yes | No | Backend/Node |
| `PROFILE_SCOPE_CI_STRICT` | Yes | No | Backend/Node |
| `PROFILE_SCOPE_STRICT` | Yes | No | Backend/Node |
| `PROFILE_TAXONOMY_DEBUG` | Yes | No | Backend/Node |
| `PUBLIC_URL` | Yes | No | Backend/Node |
| `QUEUE_DRAIN_INTERVAL_MS` | Yes | No | Backend/Node |
| `QUEUE_POLL_ENABLED` | Yes | No | Backend/Node |
| `QUEUE_POLL_INTERVAL_MS` | Yes | No | Backend/Node |
| `QUEUE_STAGGER_DELAY_MS` | Yes | No | Backend/Node |
| `QUEUE_STARTUP_DELAY_MS` | Yes | No | Backend/Node |
| `RAILWAY_DEPLOYMENT_ID` | Yes | No | Backend/Node |
| `RAILWAY_DEPLOYMENT_START_TIME` | Yes | No | Backend/Node |
| `RAILWAY_ENVIRONMENT` | Yes | No | Backend/Node |
| `RAILWAY_GIT_BRANCH` | Yes | No | Backend/Node |
| `RAILWAY_GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `RAILWAY_PROJECT_ID` | Yes | No | Backend/Node |
| `RAILWAY_SERVICE_ID` | Yes | No | Backend/Node |
| `RAILWAY_STATIC_URL` | Yes | No | Backend/Node |
| `REQUEST_ID_ERROR_STORE_MAX` | Yes | No | Backend/Node |
| `REQUEST_TIMEOUT_MS` | Yes | No | Backend/Node |
| `RESEND_API_KEY` | Yes | Yes | Backend/Node |
| `RUNTIME_SECRETS_KEY` | Yes | No | Backend/Node |
| `RUN_GEO_CRAWL` | Yes | No | Backend/Node |
| `RUN_ITEM_CRAWLERS` | Yes | No | Backend/Node |
| `RUN_SQLITE_MIGRATION` | Yes | No | Backend/Node |
| `SAM_GOV_API_BASE_URL` | Yes | No | Backend/Node |
| `SAM_GOV_API_KEY` | Yes | No | Backend/Node |
| `SAM_GOV_PUBLIC_API_KEY` | Yes | No | Backend/Node |
| `SEED_KEY` | Yes | No | Backend/Node |
| `SEED_PATH` | Yes | No | Backend/Node |
| `SENTRY_DSN` | No | Yes |  |
| `SERVICE_APPLICATION_EMAIL` | Yes | No | Backend/Node |
| `SESSION_SECRET` | Yes | No | Backend/Node |
| `SHOULDERS_VNEXT` | Yes | No | Backend/Node |
| `SIMPLER_GRANTS_API_KEY` | Yes | No | Backend/Node |
| `SKIP_NETWORK_TESTS` | Yes | No | Backend/Node |
| `SMART_MATCHER_INTENT_MODEL` | Yes | No | Backend/Node |
| `SMOKE_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `SMOKE_API_BASE` | Yes | No | Backend/Node |
| `SMOKE_BASE_PATH` | Yes | No | Backend/Node |
| `SMOKE_BASE_URL` | Yes | No | Backend/Node |
| `SMOKE_CHECK_PROFILE_SCHEMA` | Yes | No | Backend/Node |
| `SMOKE_DEBUG` | Yes | No | Backend/Node |
| `SMOKE_MAX_CLICKS` | Yes | No | Backend/Node |
| `SMOKE_MAX_PER_SELECTOR` | Yes | No | Backend/Node |
| `SMOKE_MAX_ROUTES` | Yes | No | Backend/Node |
| `SMOKE_MODE` | Yes | No | Backend/Node |
| `SMOKE_TARGET_PATH` | Yes | No | Backend/Node |
| `SOURCE` | Yes | No | Backend/Node |
| `SQLITE_BUSY_TIMEOUT_MS` | Yes | No | Backend/Node |
| `SQLITE_CACHE_SIZE_KB` | Yes | No | Backend/Node |
| `SQLITE_DB_PATH` | Yes | Yes | Backend/Node |
| `STARTUP_PROFILE_ORG_LINK_LIMIT` | Yes | No | Backend/Node |
| `STARTUP_SMOKE_CRAWL_ENABLED` | Yes | No | Backend/Node |
| `STRIPE_MOCK` | Yes | No | Backend/Node |
| `STRIPE_SECRET_KEY` | Yes | Yes | Backend/Node |
| `STRIPE_WEBHOOK_SECRET` | Yes | Yes | Backend/Node |
| `TEST_API_URL` | Yes | No | Backend/Node |
| `TEST_CONCURRENCY` | Yes | No | Backend/Node |
| `TEST_STATE` | Yes | No | Backend/Node |
| `TEST_ZIP` | Yes | No | Backend/Node |
| `TWILIO_ACCOUNT_SID` | Yes | Yes | Backend/Node |
| `TWILIO_AUTH_TOKEN` | Yes | Yes | Backend/Node |
| `TWILIO_FROM_NUMBER` | Yes | No | Backend/Node |
| `TWILIO_MESSAGING_SERVICE_SID` | Yes | Yes | Backend/Node |
| `UNIT_TEST_CONCURRENCY` | Yes | No | Backend/Node |
| `UNIT_TEST_HARD_TIMEOUT_MS` | Yes | No | Backend/Node |
| `UPLOADS_DIR` | Yes | Yes | Backend/Node |
| `UPLOADS_PERSIST_PREFIXES` | Yes | No | Backend/Node |
| `UPLOAD_DIR` | Yes | No | Backend/Node |
| `URL_VERIFICATION_ENABLED` | Yes | No | Backend/Node |
| `VERCEL` | Yes | No | Backend/Node |
| `VERCEL_ENV` | Yes | No | Backend/Node |
| `VERCEL_GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `VERIFY_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `VERIFY_BACKEND_BASE_URL` | Yes | No | Backend/Node |
| `VERIFY_BASE_URL` | Yes | No | Backend/Node |
| `VERIFY_DB_PATH` | Yes | No | Backend/Node |
| `VERIFY_GEO_RUN_ID` | Yes | No | Backend/Node |
| `VERIFY_PROFILE_ID` | Yes | No | Backend/Node |
| `VERIFY_UI_BASE_URL` | Yes | No | Backend/Node |
| `VERIFY_UI_OUT_DIR` | Yes | No | Backend/Node |
| `VITE_ANYA_COPILOT_ENABLED` | Yes | No | Frontend (Vite) |
| `VITE_ANYA_SCREENSHOT_ENABLED` | Yes | No | Frontend (Vite) |
| `VITE_API_PROXY_TARGET` | No | Yes |  |
| `VITE_API_URL` | Yes | Yes | Frontend (Vite) |
| `VITE_APP_BASE` | Yes | Yes | Used in both backend + frontend |
| `VITE_ASSET_BASE` | Yes | Yes | Backend/Node |
| `VITE_CANONICAL_HOST` | Yes | No | Frontend (Vite) |
| `VITE_CANONICAL_HOST_STRICT` | Yes | No | Frontend (Vite) |
| `VITE_DEV_ADMIN_TOKEN` | Yes | No | Frontend (Vite) |
| `VITE_ENABLE_CLICK_TRACER` | Yes | No | Frontend (Vite) |
| `VITE_ENABLE_CLIENT_LOGS` | Yes | No | Frontend (Vite) |
| `VITE_FORCE_RAILWAY_API` | Yes | No | Frontend (Vite) |
| `VITE_SHOULDERS_VNEXT` | Yes | No | Frontend (Vite) |
| `VITE_SMOKE_MODE` | Yes | No | Backend/Node |
| `VITE_SUPPORT_EMAIL` | Yes | No | Frontend (Vite) |
| `VITE_SUPPORT_FAX` | Yes | No | Frontend (Vite) |
| `X_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `ZIP_COUNTY_MAP_PATH` | Yes | No | Backend/Node |

## Usage locations (file + line ranges)

### `ACCESS_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L26` (process.env)

### `ADMIN_EMAIL`

- **Templates**:
  - `.env.example:31` = `admin@grantflow.app`
  - `backend/env.example:35` = `admin@grantflow.local`
- **Code references**:
  - `backend/config/constants.js:L11` (process.env)
  - `backend/scripts/seed-deterministic.mjs:L50` (process.env)
  - `backend/server.js:L143` (process.env)
  - `backend/services/anyaOrchestrator.js:L14` (process.env)
  - `backend/services/email.js:L199` (process.env)
  - `scripts/ensure-admin-user.mjs:L19` (process.env)
  - `tests/e2e/playwright.config.mjs:L34` (process.env)

### `ADMIN_EMAILS`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/constants.js:L18` (process.env)

### `ADMIN_HEALTH_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/middleware/authIdentity.js:L54` (process.env)
  - `backend/services/codeGuardService.js:L80` (process.env)

### `ADMIN_LOGIN_EVENT_BUFFER`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/adminLoginEventStore.js:L6` (process.env)

### `ADMIN_NAME`

- **Templates**:
  - `.env.example:34` = `Admin User`
  - `backend/env.example:34` = `Local Admin`
- **Code references**:
  - `backend/scripts/seed-deterministic.mjs:L51` (process.env)
  - `backend/server.js:L142` (process.env)
  - `scripts/ensure-admin-user.mjs:L21` (process.env)
  - `tests/e2e/playwright.config.mjs:L35` (process.env)

### `ADMIN_PHONE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/ensure-admin-user.mjs:L20` (process.env)

### `ADMIN_SELF_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAdminTools.js:L1285` (process.env)

### `ADMIN_TOKEN`

- **Templates**:
  - `backend/env.example:33` = ``
- **Code references**:
  - `backend/routes/anya.js:L25` (process.env)
  - `backend/routes/authMe.js:L272` (process.env)
  - `backend/scripts/check-crawler-results.mjs:L25` (process.env)
  - `backend/server.js:L141–L1482` (process.env)
  - `backend/services/anyaAdminTools.js:L1322` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L212` (process.env)
  - `backend/services/anyaStartupAudit.js:L41` (process.env)
  - `backend/services/anyaToolRegistry.js:L3327–L3500` (process.env)
  - `backend/services/codeGuardService.js:L81` (process.env)
  - `backend/tests/testServer.js:L18` (process.env)
  - `scripts/_lib/secrets.mjs:L21` (process.env)
  - `scripts/dedupe-profiles.mjs:L29` (process.env)
  - `scripts/doctor.mjs:L79` (process.env)
  - `scripts/run-all-real-crawlers.mjs:L5` (process.env)
  - `scripts/runtime-crawl-local.mjs:L129` (process.env)
  - `scripts/smoke-docs-local.mjs:L18` (process.env)
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L28` (process.env)
  - `scripts/verify-prod-issues.mjs:L12` (process.env)
  - `tests/helpers/backendHarness.mjs:L51` (process.env)
  - `tests/integration/grants-from-opportunity.test.mjs:L23` (process.env)
  - `tests/manual/test-from-opportunity-comprehensive.mjs:L10` (process.env)
  - `tests/smoke/admin-tools-button-live.spec.mjs:L23` (process.env)
  - `tests/unit/api-contracts.test.mjs:L55` (process.env)
  - `tmp/migration/grantflow-migration/backend/routes/anya.js:L8` (process.env)

### `ALERT_FAILURE_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/dataReadinessService.js:L206` (process.env)

### `ALERT_QUEUE_BACKLOG_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/dataReadinessService.js:L185` (process.env)

### `ALLOW_ANYA_TEST_REPAIR_MUTATIONS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaTestRepair.js:L18` (process.env)
  - `tests/unit/security-hardening.test.mjs:L44–L72` (process.env)

### `ALLOW_AUTO_ROUTE_GENERATION`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaTestRepair.js:L23` (process.env)
  - `tests/unit/security-hardening.test.mjs:L45–L74` (process.env)

### `ALLOW_DESTRUCTIVE_SEED`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/seed-deterministic.mjs:L39` (process.env)

### `ALLOW_DEV_FILESYSTEM_AUDIT_LOGS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousCrawler.js:L642` (process.env)
  - `backend/services/anyaAutonomousFunctionRunner.js:L51–L747` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L89–L703` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L111` (process.env)
  - `backend/services/nationalPrograms/audit.js:L43` (process.env)

### `ALLOW_EPHEMERAL_SQLITE`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L739` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L10` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L13` (process.env)
  - `backend/server.js:L193` (process.env)
  - `backend/startup/bootstrap.js:L403` (process.env)

### `ALLOW_EPHEMERAL_UPLOADS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L199` (process.env)
  - `backend/server.js:L160` (process.env)
  - `backend/startup/bootstrap.js:L27` (process.env)

### `ALLOW_LEGACY_PROFILE_TOKEN`

- **Templates**:
  - `backend/env.example:37` = `false`
- **Code references**:
  - `backend/middleware/authIdentity.js:L247` (process.env)
  - `backend/server.js:L1400` (process.env)
  - `tests/unit/authIdentity.test.mjs:L285–L337` (process.env)

### `ALLOW_SQLITE_IN_PROD`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L690` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L11` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L14` (process.env)

### `ANALYTICS_WRITE_KEY`

- **Templates**:
  - `backend/env.example:180` = ``
- **Code references**: (none)

### `ANTHROPIC_API_KEY`

- **Templates**:
  - `backend/env.example:92` = `sk-ant-your-anthropic-key`
- **Code references**:
  - `audit-reports/anya-audit-1777137311589.json:L21023–L37059` (process.env)
  - `audit-reports/anya-audit-1777137980877.json:L21023–L37059` (process.env)
  - `backend/routes/admin.js:L555–L558` (process.env)
  - `backend/routes/ai.js:L49–L53` (process.env)
  - `backend/routes/anya.js:L130–L195` (process.env)
  - `backend/routes/nofo.js:L21–L24` (process.env)
  - `backend/routes/profiles.js:L404–L408` (process.env)
  - `backend/services/anyaOrchestrator.js:L39` (process.env)
  - `backend/services/diagnosticsService.js:L347` (process.env)
  - `backend/services/documentIngestion.js:L53–L771` (process.env)
  - `backend/services/pipelineAutomation.js:L67` (process.env)
  - `backend/tests/profileSectionAiFallback.test.js:L11` (process.env)
  - `backend/utils/aiProviders.js:L8` (process.env)
  - `scripts/diagnose-anya.mjs:L35–L48` (process.env)

### `ANTHROPIC_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/aiProviders.js:L25` (process.env)

### `ANTHROPIC_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L723` (process.env)
  - `backend/routes/ai.js:L140–L552` (process.env)
  - `backend/routes/nofo.js:L216` (process.env)
  - `backend/routes/profiles.js:L1958–L2135` (process.env)
  - `backend/services/anyaOrchestrator.js:L64–L1279` (process.env)
  - `backend/services/documentIngestion.js:L825` (process.env)
  - `backend/services/pipelineAutomation.js:L412` (process.env)
  - `backend/utils/aiProviders.js:L113–L188` (process.env)

### `ANTHROPIC_MODEL_SCHOOL_LOOKUP`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/ai.js:L1651` (process.env)

### `ANTHROPIC_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/aiProviders.js:L24` (process.env)

### `ANYA_ADMIN_GEO_COOLDOWN_HOURS`

- **Templates**:
  - `backend/env.example:136` = `24`
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L29` (process.env)

### `ANYA_ADMIN_GEO_ON_LOGIN`

- **Templates**:
  - `backend/env.example:134` = `true`
- **Code references**: (none)

### `ANYA_ADMIN_GEO_OVERPASS_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L108` (process.env)

### `ANYA_ADMIN_GEO_OVERPASS_RADIUS_KM`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L107` (process.env)

### `ANYA_ADMIN_GEO_SKIP_DOMAIN_CORPUS`

- **Templates**:
  - `backend/env.example:140` = `true`
- **Code references**: (none)

### `ANYA_ADMIN_GEO_STATE_PACING_MS`

- **Templates**:
  - `backend/env.example:138` = `2000`
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L104` (process.env)

### `ANYA_ADMIN_TOKEN`

- **Templates**:
  - `backend/env.example:45` = `anya-dev-token`
- **Code references**:
  - `backend/routes/anya.js:L25` (process.env)
  - `backend/routes/authMe.js:L272` (process.env)
  - `backend/server.js:L141–L1482` (process.env)
  - `backend/services/anyaAdminTools.js:L1322` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L212` (process.env)
  - `backend/services/anyaStartupAudit.js:L41` (process.env)
  - `backend/services/anyaToolRegistry.js:L3327–L3500` (process.env)
  - `backend/services/codeGuardService.js:L81` (process.env)
  - `backend/services/diagnosticsService.js:L352` (process.env)
  - `backend/tests/testServer.js:L19` (process.env)
  - `scripts/_lib/secrets.mjs:L22` (process.env)
  - `scripts/dedupe-profiles.mjs:L29` (process.env)
  - `scripts/verify-prod-issues.mjs:L12` (process.env)
  - `tmp/migration/grantflow-migration/backend/routes/anya.js:L8` (process.env)

### `ANYA_ALLOW_CODE_EDIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAdminTools.js:L830` (process.env)

### `ANYA_ANTHROPIC_COOLDOWN_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L34` (process.env)

### `ANYA_ANTHROPIC_FAILURE_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L33` (process.env)

### `ANYA_ANTHROPIC_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L560` (process.env)
  - `backend/routes/ai.js:L55` (process.env)
  - `backend/routes/anya.js:L153` (process.env)
  - `backend/routes/nofo.js:L26` (process.env)
  - `backend/routes/profiles.js:L410` (process.env)
  - `backend/services/anyaOrchestrator.js:L45` (process.env)
  - `backend/services/documentIngestion.js:L60` (process.env)
  - `backend/services/pipelineAutomation.js:L73` (process.env)
  - `backend/utils/aiProviders.js:L25` (process.env)

### `ANYA_ANTHROPIC_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L559` (process.env)
  - `backend/routes/ai.js:L54` (process.env)
  - `backend/routes/anya.js:L152` (process.env)
  - `backend/routes/nofo.js:L25` (process.env)
  - `backend/routes/profiles.js:L409` (process.env)
  - `backend/services/anyaOrchestrator.js:L44` (process.env)
  - `backend/services/documentIngestion.js:L59` (process.env)
  - `backend/services/pipelineAutomation.js:L72` (process.env)
  - `backend/utils/aiProviders.js:L24` (process.env)

### `ANYA_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/middleware/authIdentity.js:L53` (process.env)
  - `backend/server.js:L1271–L1304` (process.env)
  - `tests/unit/authIdentity.test.mjs:L119–L375` (process.env)

### `ANYA_AUTONOMOUS_ENABLED`

- **Templates**:
  - `backend/env.example:125` = `false`
- **Code references**:
  - `audit-reports/anya-audit-1777137311589.json:L12303–L41481` (process.env)
  - `audit-reports/anya-audit-1777137980877.json:L12303–L41481` (process.env)
  - `backend/server.js:L2549` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L30` (process.env)
  - `backend/services/anyaBootstrap.js:L73` (process.env)
  - `backend/tests/testServer.js:L22` (process.env)
  - `scripts/check-anya-status.mjs:L23–L107` (process.env)

### `ANYA_AUTONOMOUS_WRITES`

- **Templates**:
  - `backend/env.example:156` = `0 # 1 to arm the host-level gate`
- **Code references**:
  - `backend/services/anyaAutonomousCrawler.js:L702` (process.env)
  - `scripts/anya-autonomous.mjs:L92` (process.env)

### `ANYA_AUTONOMOUS_WRITE_CHANGES`

- **Templates**:
  - `backend/env.example:158` = `false`
- **Code references**:
  - `backend/services/anyaAutonomousCrawler.js:L702` (process.env)
  - `backend/tests/adminAnyaRunAutonomousRoute.test.js:L131–L149` (process.env)
  - `backend/tests/anyaAutonomousCrawler.real.test.js:L119–L409` (process.env)
  - `scripts/anya-autonomous.mjs:L92` (process.env)

### `ANYA_AUTO_REPAIR`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutoRepairService.js:L848` (process.env)

### `ANYA_CODE_CRAWL`

- **Templates**:
  - `backend/env.example:143` = `true              # Scan and fix code issues`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L39` (process.env)

### `ANYA_CRAWLERS`

- **Templates**:
  - `backend/env.example:145` = `true                # Run grant crawlers`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L41` (process.env)

### `ANYA_DRY_RUN`

- **Templates**:
  - `backend/env.example:167` = `false                # Dry run mode (no actual changes)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L56–L68` (process.env)

### `ANYA_FIX_CONSOLE`

- **Templates**:
  - `backend/env.example:148` = `true             # Fix console.log statements`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L53` (process.env)

### `ANYA_FIX_EMPTY_CATCH`

- **Templates**:
  - `backend/env.example:149` = `true         # Fix empty catch blocks`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L54` (process.env)

### `ANYA_FIX_ERRORS`

- **Templates**:
  - `backend/env.example:166` = `false             # Auto-fix found errors`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L67` (process.env)

### `ANYA_FUNCTION_TESTS`

- **Templates**:
  - `backend/env.example:144` = `true          # Test API endpoints`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L40` (process.env)

### `ANYA_FUNCTION_TEST_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousFunctionTesting.js:L306` (process.env)

### `ANYA_GEO_CRAWL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L44` (process.env)

### `ANYA_HEALTH_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaHealthService.js:L314` (process.env)
  - `tests/unit/health-service-singleton.test.mjs:L14` (process.env)

### `ANYA_ITEM_DISCOVERY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L42` (process.env)

### `ANYA_ITEM_DISCOVERY_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L72` (process.env)

### `ANYA_ITEM_DISCOVERY_MIN_COUNT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L71` (process.env)

### `ANYA_MATCH_THRESHOLD`

- **Templates**:
  - `backend/env.example:161` = `80           # Min % match to save to profile (0-100)`
- **Code references**: (none)

### `ANYA_MAX_FILE_CHANGES`

- **Templates**:
  - `backend/env.example:150` = `20          # Max files to modify per run`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L55` (process.env)

### `ANYA_OPENAI_COOLDOWN_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L20` (process.env)

### `ANYA_OPENAI_FAILURE_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L19` (process.env)

### `ANYA_OPENAI_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L78` (process.env)

### `ANYA_OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L63` (process.env)
  - `backend/services/anyaToolRegistry.js:L895` (process.env)
  - `backend/utils/aiProviders.js:L96–L156` (process.env)

### `ANYA_OPENAI_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L73` (process.env)

### `ANYA_PORTAL_CHECKS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L43` (process.env)

### `ANYA_RUN_ON_ADMIN_LOGIN`

- **Templates**:
  - `backend/env.example:129` = `false    # Run when admin logs in`
- **Code references**:
  - `backend/routes/auth.js:L2043` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L34` (process.env)

### `ANYA_RUN_ON_SCHEDULE`

- **Templates**:
  - `backend/env.example:130` = `false       # Run on schedule (cron)`
- **Code references**:
  - `backend/server.js:L2571` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L35` (process.env)
  - `backend/services/anyaBootstrap.js:L100` (process.env)
  - `backend/startup/backgroundServices.js:L173` (process.env)

### `ANYA_RUN_ON_STARTUP`

- **Templates**:
  - `backend/env.example:128` = `false        # Run when server starts`
- **Code references**:
  - `audit-reports/anya-audit-1777137311589.json:L12313–L41490` (process.env)
  - `audit-reports/anya-audit-1777137980877.json:L12313–L41490` (process.env)
  - `backend/server.js:L2551` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L33` (process.env)
  - `backend/services/anyaBootstrap.js:L58` (process.env)
  - `backend/startup/backgroundServices.js:L161` (process.env)
  - `scripts/check-anya-status.mjs:L24` (process.env)

### `ANYA_SAVE_GLOBAL`

- **Templates**:
  - `backend/env.example:162` = `true             # Save all opportunities globally`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L63` (process.env)

### `ANYA_SCHEDULE`

- **Templates**:
  - `backend/env.example:131` = `0 3 * * *           # Cron schedule (default: 3 AM daily)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L48` (process.env)

### `ANYA_SELF_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/anya.js:L33` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L194` (process.env)

### `ANYA_USAGE_RETENTION_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/jobs/anyaBrainCleanup.js:L23` (process.env)

### `ANYA_WAIT_COMPLETION`

- **Templates**:
  - `backend/env.example:163` = `false        # Wait for crawlers to complete`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L64` (process.env)

### `API_BASE`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/check-crawler-results.mjs:L24` (process.env)

### `API_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-auth-diagnostics.mjs:L12` (process.env)
  - `scripts/verify-prod-issues.mjs:L11` (process.env)
  - `tests/e2e/playwright.config.mjs:L8` (process.env)
  - `tests/smoke/playwright.config.mjs:L4` (process.env)

### `API_DATA_GOV_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L345` (process.env)

### `API_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/diagnose-anya.mjs:L22` (process.env)

### `APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/profiles.js:L2520` (process.env)

### `APPLY`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/repair-profile-ownership.mjs:L167` (process.env)

### `APPLY_STORAGE_DIR`

- **Templates**: (not present)
- **Code references**:
  - `backend/apply/storageAdapter.js:L9` (process.env)
  - `backend/scripts/smoke-apply-engine.mjs:L60` (process.env)

### `APP_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L157` (process.env)

### `AUTH_ACCESS_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:61` = `10800`
- **Code references**:
  - `backend/routes/auth.js:L129` (process.env)

### `AUTH_ALLOW_ADMIN_PREVIEW_CODE`

- **Templates**:
  - `backend/env.example:113` = `false`
- **Code references**: (none)

### `AUTH_ALLOW_PREVIEW_CODE_IN_PROD`

- **Templates**:
  - `backend/env.example:107` = `false`
- **Code references**: (none)

### `AUTH_EMAIL_CODE_TTL`

- **Templates**:
  - `backend/env.example:63` = `600`
- **Code references**:
  - `backend/routes/auth.js:L131` (process.env)

### `AUTH_EMAIL_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L201` (process.env)

### `AUTH_EMAIL_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:64` = `45`
- **Code references**:
  - `backend/routes/auth.js:L132` (process.env)

### `AUTH_EMAIL_SEND_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L1743–L2734` (process.env)

### `AUTH_FACEBOOK_CLIENT_ID`

- **Templates**:
  - `backend/env.example:172` = `facebook-client-id`
- **Code references**: (none)

### `AUTH_FACEBOOK_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:173` = `facebook-client-secret`
- **Code references**: (none)

### `AUTH_FRONTEND_APP_BASE`

- **Templates**:
  - `backend/env.example:71` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L157` (process.env)
  - `backend/server.js:L565` (process.env)

### `AUTH_FRONTEND_URL`

- **Templates**:
  - `backend/env.example:70` = `http://localhost:5173`
- **Code references**:
  - `backend/routes/auth.js:L155` (process.env)
  - `backend/services/diagnosticsService.js:L356` (process.env)

### `AUTH_GOOGLE_CLIENT_ID`

- **Templates**:
  - `backend/env.example:170` = `google-client-id`
- **Code references**: (none)

### `AUTH_GOOGLE_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:171` = `google-client-secret`
- **Code references**: (none)

### `AUTH_JWT_SECRET`

- **Templates**:
  - `backend/env.example:60` = `dev-secret-change-me`
- **Code references**:
  - `backend/routes/authMe.js:L269` (process.env)
  - `backend/routes/health.js:L73` (process.env)
  - `backend/server.js:L1207–L1479` (process.env)
  - `backend/utils/runtimeSecrets.js:L31` (process.env)
  - `scripts/verify-stability.mjs:L17` (process.env)

### `AUTH_NOTIFY_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L351` (process.env)
  - `backend/services/email.js:L199` (process.env)

### `AUTH_NOTIFY_ON_LOGIN`

- **Templates**:
  - `backend/env.example:101` = `true`
- **Code references**:
  - `backend/services/diagnosticsService.js:L350` (process.env)
  - `backend/services/email.js:L198` (process.env)

### `AUTH_OAUTH_STATE_TTL`

- **Templates**:
  - `backend/env.example:67` = `600`
- **Code references**:
  - `backend/routes/auth.js:L135` (process.env)

### `AUTH_PASSWORD_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L215` (process.env)

### `AUTH_PASSWORD_SETUP_TTL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L136` (process.env)

### `AUTH_PHONE_CODE_TTL`

- **Templates**:
  - `backend/env.example:65` = `600`
- **Code references**:
  - `backend/routes/auth.js:L133` (process.env)

### `AUTH_PHONE_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L208` (process.env)

### `AUTH_PHONE_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:66` = `60`
- **Code references**:
  - `backend/routes/auth.js:L134` (process.env)

### `AUTH_PUBLIC_URL`

- **Templates**:
  - `backend/env.example:69` = `http://localhost:5173/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L154` (process.env)
  - `backend/routes/stripe.js:L16` (process.env)
  - `backend/services/diagnosticsService.js:L355` (process.env)

### `AUTH_REFRESH_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:62` = `2592000`
- **Code references**:
  - `backend/routes/auth.js:L130` (process.env)

### `AUTH_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/check-crawler-results.mjs:L25` (process.env)
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L27` (process.env)

### `AUTH_YAHOO_CLIENT_ID`

- **Templates**:
  - `backend/env.example:174` = `yahoo-client-id`
- **Code references**: (none)

### `AUTH_YAHOO_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:175` = `yahoo-client-secret`
- **Code references**: (none)

### `AUTO_POPULATE_PER_SECTION_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/apply/applyEngine.js:L1125` (process.env)

### `AUTO_POPULATE_TOTAL_BUDGET_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/apply/applyEngine.js:L1128` (process.env)

### `AWS_ACCESS_KEY_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/documentIngestion/ocr/providers/awsTextract.js:L22` (process.env)

### `AWS_REGION`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/documentIngestion/ocr/providers/awsTextract.js:L19` (process.env)

### `AWS_SESSION_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/documentIngestion/ocr/providers/awsTextract.js:L26` (process.env)

### `BACKEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L81–L128` (process.env)

### `BACKEND_PORT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAdminTools.js:L1287` (process.env)
  - `scripts/runtime-crawl-local.mjs:L79` (process.env)

### `BASELINE_SEED_MODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L973` (process.env)
  - `backend/startup/selfHeal.js:L53` (process.env)

### `BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-all-real-crawlers.mjs:L4` (process.env)
  - `src/components/banners/ProBonoBanner.jsx:L9` (import.meta.env)
  - `src/config/env.js:L32` (import.meta.env)
  - `src/utils/enforceBasename.js:L13` (import.meta.env)
  - `src/utils/index.js:L27` (import.meta.env)

### `BEARER_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L25` (process.env)

### `BUILD_TIME`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/version.js:L39` (process.env)

### `BUILD_TIMESTAMP`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2059` (process.env)

### `BULK_POPULATE_KEY`

- **Templates**:
  - `backend/env.example:36` = ``
- **Code references**:
  - `backend/middleware/authIdentity.js:L52` (process.env)
  - `backend/routes/authMe.js:L273` (process.env)
  - `backend/routes/crawlerV2.js:L11` (process.env)
  - `backend/routes/crawlers.js:L1634–L2352` (process.env)
  - `backend/server.js:L1249–L1483` (process.env)
  - `tests/unit/authIdentity.test.mjs:L93–L162` (process.env)

### `CI`

- **Templates**: (not present)
- **Code references**:
  - `scripts/ensure-build-natives.mjs:L89` (process.env)
  - `tests/e2e/playwright.config.mjs:L18–L32` (process.env)
  - `tests/smoke/playwright.config.mjs:L12–L25` (process.env)

### `COMMIT_AUDIT_OUT_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/audit-commits-14d.mjs:L66` (process.env)

### `COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L44–L321` (process.env)
  - `backend/server.js:L1787` (process.env)
  - `backend/startup/backgroundServices.js:L308` (process.env)

### `COMPREHENSIVE_GEO_JOB_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L84` (process.env)
  - `backend/services/dataReadinessService.js:L156` (process.env)

### `COMPREHENSIVE_JOB_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L74` (process.env)

### `CONFIRM`

- **Templates**: (not present)
- **Code references**:
  - `scripts/godaddy-set-vercel-dns.mjs:L93` (process.env)

### `CORE_TIMEOUT_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L187` (process.env)

### `CORS_ORIGIN`

- **Templates**:
  - `backend/env.example:44` = `http://localhost:5173,http://127.0.0.1:5173,https://app.axiombiolabs.org,https://www.axiombiolabs.org`
- **Code references**:
  - `backend/services/deadlineEmailSmsService.js:L61` (process.env)
  - `scripts/doctor.mjs:L80` (process.env)
  - `tests/helpers/backendHarness.mjs:L52` (process.env)
  - `tests/unit/anya-tasks.test.mjs:L38` (process.env)
  - `tests/unit/api-contracts.test.mjs:L56` (process.env)
  - `tmp/migration/grantflow-migration/backend/server.js:L25` (process.env)

### `CRAWLER_DATA_DIR`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/populate-geo-coverage.mjs:L62–L63` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L20–L22` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L24–L25` (process.env)
  - `backend/scripts/run-geo-profile-zips.mjs:L13–L14` (process.env)
  - `backend/services/comprehensiveCrawlerOptimized.js:L38–L38` (process.env)
  - `backend/services/crawlerDispatcher.js:L32–L33` (process.env)
  - `backend/tests/testServer.js:L21` (process.env)
  - `tests/e2e/playwright.config.mjs:L11` (process.env)

### `CRAWLER_DISPATCH_BASE_DELAY_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L302` (process.env)

### `CRAWLER_DISPATCH_MAX_ATTEMPTS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L298` (process.env)

### `CRAWLER_DISPATCH_MAX_DELAY_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L303` (process.env)

### `CRAWLER_JOB_STUCK_THRESHOLD_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/dataReadinessService.js:L159` (process.env)

### `CRAWLER_JOB_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L61` (process.env)

### `CRAWLER_MAX_CONCURRENCY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L293` (process.env)

### `CRAWLER_MAX_RETRY_DELAY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/jobBackpressure.js:L23` (process.env)

### `CRAWLER_MAX_SOURCES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-doctor.mjs:L140` (process.env)
  - `scripts/crawler-run.mjs:L31` (process.env)
  - `scripts/crawler-smoke.mjs:L61` (process.env)

### `CRAWLER_MAX_URLS_PER_SOURCE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L32` (process.env)
  - `scripts/crawler-smoke.mjs:L62` (process.env)

### `CRAWLER_MODE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L28` (process.env)

### `CRAWLER_RETRY_BASE_DELAY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/jobBackpressure.js:L18` (process.env)

### `CRAWLER_STALE_CLEANUP_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L34` (process.env)

### `CRAWLER_STALE_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/crawlerV2.js:L40` (process.env)

### `CRAWLER_STALE_RUNNING_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L33` (process.env)

### `CRAWLER_STATE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L29` (process.env)

### `CRAWLER_TIMEOUT_SECONDS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L33` (process.env)
  - `scripts/crawler-smoke.mjs:L63` (process.env)

### `CRAWLER_USE_LIVE_SOURCES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L30` (process.env)

### `DATABASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/audit-section-metadata.mjs:L38` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L43` (process.env)
  - `scripts/fix-malformed-json.mjs:L20` (process.env)
  - `scripts/ingest-grantsgov.mjs:L17` (process.env)
  - `scripts/ingest-usaspending.mjs:L17` (process.env)
  - `scripts/ingest.mjs:L18` (process.env)
  - `scripts/seed-profile-grants.mjs:L57` (process.env)
  - `scripts/seed-real-opportunities.mjs:L22` (process.env)
  - `scripts/verify-nih-reporter-live-ingest.mjs:L34` (process.env)

### `DATABASE_PUBLIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L314` (process.env)

### `DATABASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L13–L31` (process.env)
  - `backend/import-data.js:L24` (process.env)
  - `backend/scripts/check-opps.mjs:L3` (process.env)
  - `backend/scripts/check-tables.mjs:L3` (process.env)
  - `backend/scripts/cleanup-funding-opportunities.mjs:L27` (process.env)
  - `backend/scripts/create-quick-profiles.mjs:L4` (process.env)
  - `backend/scripts/db-summary.mjs:L3` (process.env)
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L314` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L53` (process.env)
  - `scripts/check-db.mjs:L3` (process.env)
  - `scripts/crawler-doctor.mjs:L18` (process.env)
  - `scripts/crawler-run.mjs:L19` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L23` (process.env)
  - `scripts/seed-matched-grants.mjs:L37` (process.env)
  - `scripts/seed-profile-grants.mjs:L22` (process.env)
  - `tmp/migration/grantflow-migration/backend/import-data.js:L26` (process.env)
  - `tmp/migration/grantflow-migration/backend/server.js:L47` (process.env)

### `DB_AUTO_MIGRATE`

- **Templates**:
  - `backend/env.example:22` = `false`
- **Code references**:
  - `backend/server.js:L604–L949` (process.env)
  - `backend/startup/bootstrap.js:L144` (process.env)
  - `backend/tests/testServer.js:L17` (process.env)

### `DB_DIALECT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L73` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L164` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L6` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L9` (process.env)

### `DB_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L72–L354` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L41` (process.env)
  - `scripts/check-profiles.mjs:L45–L46` (process.env)
  - `scripts/crawler-smoke.mjs:L17` (process.env)
  - `scripts/db-opportunity-tag-stats.cjs:L3` (process.env)
  - `scripts/db-term-coverage.cjs:L3` (process.env)
  - `scripts/db-top-tags.cjs:L3` (process.env)
  - `scripts/db-url-stats.cjs:L3` (process.env)
  - `scripts/ensure-admin-user.mjs:L24` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L20` (process.env)
  - `scripts/reattach-users-simple.mjs:L10–L11` (process.env)
  - `scripts/run-geocrawl-all-zips.mjs:L19` (process.env)
  - `scripts/seed-profiles.mjs:L44–L45` (process.env)

### `DB_POOL_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L559` (process.env)

### `DB_PROVIDER`

- **Templates**:
  - `.env.example:125` = `sqlite`
  - `backend/env.example:9` = `sqlite`
- **Code references**:
  - `backend/db/index.js:L72` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L164` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L5` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L8` (process.env)

### `DEDUPE_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/dedupe-profiles.mjs:L28` (process.env)

### `DEPLOY_ENV`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousCrawler.js:L605` (process.env)
  - `backend/services/anyaAutonomousFunctionRunner.js:L17` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L51` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L16` (process.env)
  - `backend/services/anyaTestRepair.js:L12` (process.env)
  - `backend/services/nationalPrograms/audit.js:L10` (process.env)
  - `tests/unit/security-hardening.test.mjs:L43–L70` (process.env)

### `DEPLOY_TIMESTAMP`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L323` (process.env)

### `DEV`

- **Templates**: (not present)
- **Code references**:
  - `src/api/client.js:L15` (import.meta.env)
  - `src/components/auth/AuthErrorBoundary.jsx:L84` (import.meta.env)
  - `src/components/shared/ErrorBoundary.jsx:L16` (import.meta.env)
  - `src/components/shared/clickTracer.jsx:L4` (import.meta.env)
  - `src/config/env.js:L30` (import.meta.env)
  - `src/contexts/DashboardPreferencesContext.jsx:L191–L229` (import.meta.env)
  - `src/utils/logger.js:L11` (import.meta.env)

### `DISABLE_SEEDING`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/seed-profile-grants.mjs:L22` (process.env)
  - `backend/utils/seedOnStartup.js:L26` (process.env)
  - `scripts/prepopulate-profile-grants.mjs:L31` (process.env)
  - `scripts/seed-matched-grants.mjs:L31` (process.env)
  - `scripts/seed-profile-grants.mjs:L16` (process.env)
  - `tests/unit/matchDecisionEngine.lifecycle.test.mjs:L455–L466` (process.env)
  - `tests/unit/strict-matching-discovery.test.mjs:L322–L331` (process.env)

### `DOMAIN_CORPUS_CRAWL_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlers/domainCorpusCrawler.js:L17` (process.env)

### `DRY_RUN`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/restore-profile-sections-from-orgs.mjs:L15–L15` (process.env)
  - `scripts/cleanup-all-profiles-pipeline.mjs:L21` (process.env)
  - `scripts/run-pipeline-cleanup-now.mjs:L31` (process.env)
  - `scripts/verify-nih-reporter-live-ingest.mjs:L35` (process.env)

### `E2E_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `tests/e2e/playwright.config.mjs:L10` (process.env)

### `E2E_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `tests/e2e/playwright.config.mjs:L6` (process.env)

### `E2E_PORT`

- **Templates**: (not present)
- **Code references**:
  - `tests/e2e/playwright.config.mjs:L4` (process.env)

### `EMAIL_FROM`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L2516–L2694` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L22` (process.env)
  - `backend/services/email.js:L19–L32` (process.env)

### `ENABLE_ASSISTANCE_DIRECTORIES_SEED`

- **Templates**:
  - `backend/env.example:28` = `false`
- **Code references**: (none)

### `ENABLE_MIN_NATIONAL_ENSURE`

- **Templates**:
  - `backend/env.example:27` = `false`
- **Code references**:
  - `backend/server.js:L1075` (process.env)
  - `backend/startup/selfHeal.js:L176` (process.env)

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

### `FROM_EMAIL`

- **Templates**:
  - `backend/env.example:96` = `noreply@yourdomain.com`
- **Code references**:
  - `backend/routes/auth.js:L2516–L2694` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L22` (process.env)
  - `backend/services/diagnosticsService.js:L349` (process.env)
  - `backend/services/email.js:L19–L32` (process.env)

### `FRONTEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L155` (process.env)
  - `backend/services/diagnosticsService.js:L356` (process.env)

### `FRONTEND_COMPONENTS_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousFunctionTesting.js:L39` (process.env)

### `FUNDING_APIS_REQUIRE_KEYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/src/config/apiKeys.js:L71` (process.env)

### `GEO_BATCH_SIZE`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L390` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L28` (process.env)

### `GEO_COUNTIES_BY_STATE_PATH`

- **Templates**:
  - `backend/env.example:53` = ``
- **Code references**:
  - `backend/routes/admin.js:L88–L2139` (process.env)

### `GEO_CRAWL_FIXTURES_DIR`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/comprehensiveCrawlerOptimized.js:L293–L350` (process.env)
  - `backend/services/crawlers/nationalZipCrawler.js:L310` (process.env)

### `GEO_MIN_SOURCES_PER_ZIP`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L391` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L30` (process.env)

### `GEO_MIN_ZIP_COORDINATES`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L117` (process.env)

### `GEO_RATE_LIMIT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-geo-all-us-zips.mjs:L29` (process.env)

### `GEO_SCOPE`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L293` (process.env)

### `GEO_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L422` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L74` (process.env)

### `GEO_ZIP_COORDINATES_PATH`

- **Templates**:
  - `backend/env.example:52` = ``
- **Code references**:
  - `backend/routes/admin.js:L84–L85` (process.env)

### `GITHUB_ACTIONS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/ensure-build-natives.mjs:L91` (process.env)

### `GITHUB_REPO`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/githubSyncVehicles.js:L82` (process.env)

### `GITHUB_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/githubSyncVehicles.js:L81` (process.env)

### `GIT_BRANCH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L322` (process.env)
  - `backend/routes/version.js:L35` (process.env)

### `GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L43–L321` (process.env)
  - `backend/routes/version.js:L33` (process.env)
  - `backend/server.js:L1786` (process.env)
  - `backend/startup/backgroundServices.js:L307` (process.env)

### `GOOGLE_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L70` (process.env)

### `GOOGLE_SEARCH_CX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L71` (process.env)

### `GRANTFLOW_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L35` (process.env)
  - `scripts/verify-crawlers-prod.mjs:L32` (process.env)

### `GRANTFLOW_BEARER_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L24` (process.env)

### `GRANTFLOW_DRY_RUN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L40–L40` (process.env)

### `GRANTFLOW_PROFILE_ID`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-crawlers-prod.mjs:L33` (process.env)

### `GRANTFLOW_PROFILE_IDS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L38` (process.env)

### `GRANTFLOW_REPO_ROOT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/missionHealthService.js:L104–L105` (process.env)

### `GRANTFLOW_SEED_MODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L192` (process.env)
  - `backend/startup/bootstrap.js:L402` (process.env)

### `GRANTFLOW_SKIP_VERIFICATION_GATE`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L190` (process.env)
  - `backend/startup/bootstrap.js:L400` (process.env)

### `GRANTFLOW_TEST_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L36` (process.env)

### `GRANTFLOW_TEST_PASSWORD`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L37` (process.env)

### `GRANTFLOW_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L39` (process.env)

### `GRANTFLOW_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-crawlers-prod.mjs:L34` (process.env)

### `GRANTS_GOV_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlers/grantsGovClient.js:L36` (process.env)
  - `backend/services/diagnosticsService.js:L343` (process.env)
  - `backend/services/grantsDotGovCrawler.js:L19` (process.env)
  - `backend/services/realFundingCrawler.js:L26` (process.env)
  - `backend/src/integrations/grantsGov.js:L8` (process.env)

### `HOURS_LOOKBACK`

- **Templates**: (not present)
- **Code references**:
  - `scripts/test-auto-merge-workflow.mjs:L10` (process.env)

### `INTERNAL_API_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAdminTools.js:L1285` (process.env)

### `ITEM_SUGGESTIONS_PER_PROFILE`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L153` (process.env)

### `JWT_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/authMe.js:L269` (process.env)
  - `backend/routes/health.js:L73` (process.env)
  - `backend/server.js:L1207–L1479` (process.env)
  - `backend/utils/runtimeSecrets.js:L32` (process.env)
  - `scripts/verify-stability.mjs:L17` (process.env)

### `LEGACY_GRANT_ONLY_EXCLUDES_MATCHING`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L263` (process.env)

### `LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/repair-profile-ownership.mjs:L168` (process.env)
  - `backend/scripts/restore-profile-sections-from-orgs.mjs:L16–L16` (process.env)
  - `scripts/db-top-tags.cjs:L5` (process.env)

### `LIMIT_OPPS_PER_PROFILE`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs:L28` (process.env)

### `LINK_VERIFICATION_BATCH`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2658` (process.env)

### `LINK_VERIFICATION_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2656` (process.env)

### `LOG_BUFFER_SIZE`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/logger.js:L51` (process.env)

### `LOG_LEVEL`

- **Templates**:
  - `backend/env.example:178` = `debug`
- **Code references**:
  - `backend/utils/logger.js:L25` (process.env)

### `MAIN_DB_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/profiles-integrity.mjs:L15` (process.env)

### `MATCHING_ENGINE_FACET_DEBUG`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/matchEngine.js:L811` (process.env)

### `MATCH_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs:L27` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L152` (process.env)

### `MAX_CONCURRENT_CRAWLERS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L14` (process.env)
  - `backend/services/crawlerDispatcher.js:L293` (process.env)

### `MAX_CRAWLER_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/jobBackpressure.js:L13` (process.env)

### `MAX_EXPORT_ROWS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L1094` (process.env)

### `MAX_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L407` (process.env)

### `MAX_ORPHAN_AUTO_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L20` (process.env)

### `MAX_ZIPS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-geocrawl-all-zips.mjs:L20–L20` (process.env)

### `MIGRATE_ASSERT_FRESH`

- **Templates**: (not present)
- **Code references**:
  - `backend/start.js:L103–L103` (process.env)

### `MIGRATE_ON_BOOT`

- **Default**: ON in production / development (env unset). Pending SQL
  migrations under `backend/db/(postgres/)migrations` are applied
  automatically on every backend boot via `runPendingMigrationsOnBoot`. All
  migrations in the repo are idempotent (`CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE IF EXISTS`, etc.) so re-running a migration that's already in
  `_migrations` is a no-op.
- **Default**: OFF in `SMOKE_MODE=1` (integration tests). Smoke tests
  bootstrap a fresh `schema.sql` and exercise specific routes; replaying
  every historical migration on top corrupts the test fixture. Tests that
  genuinely need migrations applied set `MIGRATE_ON_BOOT=1` explicitly.
- **Opt out**: Set `MIGRATE_ON_BOOT=0` (also accepted: `false`, `no`, `off`)
  to skip the boot step in any mode. Run `npm run migrate` manually after
  deploy in that case.
- **Opt in**: Set `MIGRATE_ON_BOOT=1` to force the boot step even in smoke
  mode.
- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L710` (process.env)

### `MIGRATE_VERIFY_COUNTS`

- **Templates**: (not present)
- **Code references**:
  - `backend/start.js:L104–L104` (process.env)

### `MIN_NATIONAL_OPPORTUNITIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1071` (process.env)
  - `backend/startup/selfHeal.js:L170` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L138` (process.env)

### `MIN_NATIONAL_VISIBLE`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L584` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L85` (process.env)

### `MODE`

- **Templates**: (not present)
- **Code references**:
  - `src/utils/logger.js:L12` (import.meta.env)

### `NATIONAL_PROGRAMS_CRAWLER_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2734` (process.env)
  - `backend/startup/backgroundServices.js:L260` (process.env)
  - `backend/tests/testServer.js:L23` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2736` (process.env)
  - `backend/startup/backgroundServices.js:L262` (process.env)

### `NATIONAL_PROGRAMS_MAX_DEPTH`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2740` (process.env)
  - `backend/startup/backgroundServices.js:L270` (process.env)

### `NATIONAL_PROGRAMS_MAX_URLS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2739` (process.env)
  - `backend/startup/backgroundServices.js:L266` (process.env)

### `NIH_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-nih-reporter-live-ingest.mjs:L36` (process.env)

### `NIH_TEXT`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-nih-reporter-live-ingest.mjs:L37` (process.env)

### `NODE_ENV`

- **Templates**:
  - `backend/env.example:5` = `development`
- **Code references**:
  - `backend/config/env.js:L113–L241` (process.env)
  - `backend/db/index.js:L11–L663` (process.env)
  - `backend/db/scopedQuery.js:L165` (process.env)
  - `backend/middleware/errorHandler.js:L13` (process.env)
  - `backend/routes/admin.js:L3381` (process.env)
  - `backend/routes/anya.js:L127–L202` (process.env)
  - `backend/routes/auth.js:L293–L2695` (process.env)
  - `backend/routes/grants.js:L1918–L2017` (process.env)
  - `backend/routes/health.js:L51–L198` (process.env)
  - `backend/routes/nofo.js:L263` (process.env)
  - `backend/routes/reminders.js:L191–L216` (process.env)
  - `backend/routes/version.js:L36` (process.env)
  - `backend/scripts/seed-deterministic.mjs:L37` (process.env)
  - `backend/scripts/seed-profile-grants.mjs:L21` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L9` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L12` (process.env)
  - `backend/server.js:L159–L2726` (process.env)
  - `backend/services/anyaAdminTools.js:L831` (process.env)
  - `backend/services/anyaAutoRepairService.js:L847` (process.env)
  - `backend/services/anyaAutonomousCrawler.js:L604` (process.env)
  - `backend/services/anyaAutonomousFunctionRunner.js:L16` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L50` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L15` (process.env)
  - `backend/services/anyaTestRepair.js:L11–L235` (process.env)
  - `backend/services/avatarCrawler.js:L187` (process.env)
  - `backend/services/diagnosticsService.js:L37–L353` (process.env)
  - `backend/services/email.js:L20` (process.env)
  - `backend/services/missionHealthService.js:L424` (process.env)
  - `backend/services/nationalPrograms/audit.js:L9` (process.env)
  - `backend/src/config/apiKeys.js:L100` (process.env)
  - `backend/startup/backgroundServices.js:L147–L464` (process.env)
  - `backend/startup/bootstrap.js:L25–L401` (process.env)
  - `backend/startup/selfHeal.js:L175` (process.env)
  - `backend/tests/testServer.js:L11` (process.env)
  - `backend/utils/environment.js:L12–L25` (process.env)
  - `backend/utils/logger.js:L27` (process.env)
  - `backend/utils/runtimeSecrets.js:L45` (process.env)
  - `backend/utils/seedOnStartup.js:L24` (process.env)
  - `scripts/prepopulate-profile-grants.mjs:L30` (process.env)
  - `scripts/seed-matched-grants.mjs:L30` (process.env)
  - `scripts/seed-profile-grants.mjs:L15` (process.env)
  - `scripts/seed-profiles.mjs:L28` (process.env)
  - `src/components/organizations/PrintableProfile.jsx:L68` (process.env)
  - `tests/e2e/playwright.config.mjs:L32` (process.env)
  - `tests/smoke/playwright.config.mjs:L25` (process.env)
  - `tests/unit/avatar-website-cover.test.mjs:L11` (process.env)
  - `tests/unit/pipeline-source-allowlist.test.mjs:L107–L189` (process.env)
  - `tests/unit/security-hardening.test.mjs:L42–L68` (process.env)
  - `tests/unit/strict-matching-discovery.test.mjs:L307–L332` (process.env)

### `NOFO_FETCH_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/nofo.js:L65` (process.env)

### `NOFO_PARSE_MAX_TEXT_CHARS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/nofo.js:L13` (process.env)

### `OCR_PDF_DPI`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/documentIngestion/extractTextWithFallback.js:L100–L106` (process.env)

### `OCR_PDF_MAX_PAGES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/documentIngestion/extractTextWithFallback.js:L99–L105` (process.env)

### `OCR_PROVIDER`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/documentIngestion/ocr/index.js:L13` (process.env)

### `OPENAI_API_KEY`

- **Templates**:
  - `backend/env.example:81` = `sk-your-openai-key`
- **Code references**:
  - `backend/routes/admin.js:L839–L1319` (process.env)
  - `backend/routes/anya.js:L200` (process.env)
  - `backend/scripts/create-profile-from-pdf.mjs:L75` (process.env)
  - `backend/scripts/dispatch-crawlers.mjs:L9` (process.env)
  - `backend/scripts/fix-anastasia-profile.mjs:L10` (process.env)
  - `backend/scripts/process-all-jobs.mjs:L9` (process.env)
  - `backend/scripts/process-anastasia-ai.mjs:L6` (process.env)
  - `backend/scripts/process-queue.mjs:L10` (process.env)
  - `backend/scripts/read-anastasia-vision.mjs:L5` (process.env)
  - `backend/services/diagnosticsService.js:L346` (process.env)
  - `backend/tests/profileSectionAiFallback.test.js:L10` (process.env)
  - `backend/utils/openaiClient.js:L29–L55` (process.env)
  - `tmp/migration/grantflow-migration/backend/routes/ai.js:L8` (process.env)

### `OPENAI_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L78` (process.env)

### `OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/apply/applyEngine.js:L1199` (process.env)
  - `backend/config/constants.js:L52` (process.env)
  - `backend/routes/admin.js:L55` (process.env)
  - `backend/routes/grants.js:L870` (process.env)
  - `backend/routes/legacyFunctions.js:L139` (process.env)
  - `backend/routes/nofo.js:L14` (process.env)
  - `backend/routes/profiles.js:L1916–L2112` (process.env)
  - `backend/services/grantApplicationApproachAdvisor.js:L227` (process.env)
  - `backend/services/medicalNecessity.js:L337` (process.env)
  - `backend/services/pipelineAutomation.js:L391` (process.env)
  - `backend/utils/aiProviders.js:L96–L156` (process.env)

### `OPENAI_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L73` (process.env)

### `OPPORTUNITY_INSERT_VERIFY_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/opportunityInserter.js:L405` (process.env)

### `OPPORTUNITY_MIN_COUNT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/dataReadinessService.js:L27` (process.env)

### `OPPORTUNITY_STALE_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/dataReadinessService.js:L21` (process.env)

### `ORPHAN_MAINTENANCE_CONFIRM`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/maintenance-orphan-profiles.mjs:L41` (process.env)

### `OWNER_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/owner-profile-access.mjs:L15` (process.env)

### `PDF_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/read-anastasia-vision.mjs:L6` (process.env)

### `PGDATABASE`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L14–L39` (process.env)

### `PGHOST`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L14–L35` (process.env)

### `PGPASSWORD`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L38` (process.env)

### `PGPORT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L36` (process.env)

### `PGSSLMODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L40–L555` (process.env)

### `PGUSER`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L14–L37` (process.env)

### `PG_POOL_CONN_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L561` (process.env)

### `PG_POOL_IDLE_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L560` (process.env)

### `PG_POOL_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L559` (process.env)

### `PG_STATEMENT_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L562` (process.env)

### `PIPELINE_JOB_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L67` (process.env)

### `PIPELINE_SLOW_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/middleware/pipelineMonitor.js:L13` (process.env)

### `PIPELINE_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1756` (process.env)

### `PORT`

- **Templates**:
  - `.env.example:180` = `8080`
  - `backend/env.example:4` = `8080`
- **Code references**:
  - `backend/server.js:L156–L2495` (process.env)
  - `backend/services/anyaAdminTools.js:L1287` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L206` (process.env)
  - `backend/services/anyaStartupAudit.js:L39` (process.env)
  - `backend/services/anyaToolRegistry.js:L3319–L3498` (process.env)
  - `backend/tests/testServer.js:L16` (process.env)
  - `scripts/runtime-crawl-local.mjs:L79` (process.env)
  - `tests/smoke/playwright.config.mjs:L24` (process.env)
  - `tmp/migration/grantflow-migration/backend/server.js:L22` (process.env)

### `POSTGRES_DB`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L39` (process.env)

### `POSTGRES_HOST`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L35` (process.env)

### `POSTGRES_PASSWORD`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L38` (process.env)

### `POSTGRES_PORT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L36` (process.env)

### `POSTGRES_USER`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L37` (process.env)

### `PREVIEW_PORT`

- **Templates**: (not present)
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L78` (process.env)

### `PROD`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L31` (import.meta.env)
  - `src/utils/enforceCanonicalHost.js:L4` (import.meta.env)

### `PROFILE_ID`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L71` (process.env)

### `PROFILE_SCOPE_CI_STRICT`

- **Templates**: (not present)
- **Code references**:
  - `scripts/codemod/no-unscoped-profile-query.mjs:L106` (process.env)

### `PROFILE_SCOPE_STRICT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/scopedQuery.js:L166` (process.env)
  - `tests/unit/scoped-query.test.mjs:L45–L64` (process.env)

### `PROFILE_TAXONOMY_DEBUG`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/profile/profileTaxonomy.js:L975` (process.env)

### `PUBLIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L154` (process.env)
  - `backend/routes/stripe.js:L17` (process.env)
  - `backend/services/diagnosticsService.js:L355` (process.env)

### `QUEUE_DRAIN_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L755` (process.env)

### `QUEUE_POLL_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2371` (process.env)
  - `backend/startup/queueRecovery.js:L115` (process.env)

### `QUEUE_POLL_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2370` (process.env)
  - `backend/startup/queueRecovery.js:L111` (process.env)

### `QUEUE_STAGGER_DELAY_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2376` (process.env)
  - `backend/startup/queueRecovery.js:L210` (process.env)

### `QUEUE_STARTUP_DELAY_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2375` (process.env)
  - `backend/startup/queueRecovery.js:L206` (process.env)

### `RAILWAY_DEPLOYMENT_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L105` (process.env)
  - `backend/routes/anya.js:L116` (process.env)

### `RAILWAY_DEPLOYMENT_START_TIME`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2060` (process.env)

### `RAILWAY_ENVIRONMENT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L65–L102` (process.env)
  - `backend/routes/auth.js:L294–L2696` (process.env)
  - `backend/routes/health.js:L52` (process.env)
  - `backend/routes/version.js:L37–L38` (process.env)
  - `backend/server.js:L162` (process.env)
  - `backend/services/email.js:L21` (process.env)
  - `backend/startup/bootstrap.js:L29` (process.env)
  - `backend/utils/environment.js:L13–L23` (process.env)

### `RAILWAY_GIT_BRANCH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L322` (process.env)
  - `backend/routes/version.js:L35` (process.env)

### `RAILWAY_GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L104` (process.env)
  - `backend/routes/health.js:L42–L321` (process.env)
  - `backend/routes/version.js:L33` (process.env)
  - `backend/server.js:L18–L1785` (process.env)
  - `backend/startup/backgroundServices.js:L306` (process.env)

### `RAILWAY_PROJECT_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L12–L100` (process.env)
  - `backend/server.js:L163` (process.env)
  - `backend/startup/bootstrap.js:L30` (process.env)

### `RAILWAY_SERVICE_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L12–L101` (process.env)
  - `backend/server.js:L164` (process.env)
  - `backend/startup/bootstrap.js:L31` (process.env)

### `RAILWAY_STATIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L103` (process.env)

### `REQUEST_ID_ERROR_STORE_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/requestIdErrorStore.js:L1` (process.env)

### `REQUEST_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L383` (process.env)

### `RESEND_API_KEY`

- **Templates**:
  - `backend/env.example:95` = `re_your-resend-key`
- **Code references**:
  - `backend/routes/auth.js:L2515–L2693` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L16` (process.env)
  - `backend/services/diagnosticsService.js:L348` (process.env)
  - `backend/services/email.js:L18–L25` (process.env)

### `RUNTIME_SECRETS_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/runtimeSecrets.js:L4` (process.env)

### `RUN_GEO_CRAWL`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L155` (process.env)

### `RUN_ITEM_CRAWLERS`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L154` (process.env)

### `RUN_SQLITE_MIGRATION`

- **Templates**: (not present)
- **Code references**:
  - `backend/start.js:L89` (process.env)

### `SAM_GOV_API_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/connectors/samGovConnector.js:L21` (process.env)

### `SAM_GOV_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/connectors/samGovConnector.js:L66–L136` (process.env)
  - `backend/services/diagnosticsService.js:L342` (process.env)
  - `backend/services/sources/samGov.js:L54` (process.env)
  - `tests/unit/funding-api-keys.test.mjs:L32–L37` (process.env)

### `SAM_GOV_PUBLIC_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L342` (process.env)
  - `backend/src/integrations/samAssistanceListings.js:L29–L74` (process.env)
  - `tests/unit/funding-api-keys.test.mjs:L31–L36` (process.env)

### `SEED_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L3357` (process.env)

### `SEED_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/seed-profiles.mjs:L51–L52` (process.env)

### `SENTRY_DSN`

- **Templates**:
  - `backend/env.example:179` = ``
- **Code references**: (none)

### `SERVICE_APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/serviceApplication.js:L13` (process.env)

### `SESSION_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/runtimeSecrets.js:L33` (process.env)

### `SHOULDERS_VNEXT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/vnextApplications.js:L24` (process.env)
  - `backend/tests/vnext-shoulders.test.js:L12` (process.env)

### `SIMPLER_GRANTS_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/connectors/grantsGovConnector.js:L171` (process.env)
  - `backend/services/crawlers/grantsGovClient.js:L32` (process.env)
  - `backend/services/diagnosticsService.js:L344` (process.env)
  - `tests/unit/funding-api-keys.test.mjs:L11–L35` (process.env)

### `SKIP_NETWORK_TESTS`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/known-schools-liveness.test.mjs:L37` (process.env)

### `SMART_MATCHER_INTENT_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/smartMatcherIntent.js:L158` (process.env)

### `SMOKE_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L182` (process.env)
  - `tests/smoke/admin-tools-button-live.spec.mjs:L23` (process.env)

### `SMOKE_API_BASE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-docs-local.mjs:L17` (process.env)

### `SMOKE_BASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L180` (process.env)
  - `scripts/smoke-auth-callback.mjs:L49` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L51` (process.env)
  - `scripts/smoke-login.mjs:L29` (process.env)
  - `scripts/smoke-organization-profile.mjs:L51` (process.env)
  - `scripts/smoke-prod-readonly.mjs:L14` (process.env)
  - `tests/e2e/playwright.config.mjs:L10` (process.env)
  - `tests/smoke/playwright.config.mjs:L5` (process.env)

### `SMOKE_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/dedupe-profiles.mjs:L28` (process.env)
  - `scripts/runtime-crawl-local.mjs:L80–L144` (process.env)
  - `scripts/smoke-auth-callback.mjs:L17` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L19` (process.env)
  - `scripts/smoke-login.mjs:L16` (process.env)
  - `scripts/smoke-organization-profile.mjs:L19` (process.env)
  - `scripts/smoke-prod-readonly.mjs:L13` (process.env)
  - `tests/e2e/playwright.config.mjs:L7` (process.env)
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
  - `scripts/doctor.mjs:L186` (process.env)

### `SMOKE_MAX_PER_SELECTOR`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L187` (process.env)

### `SMOKE_MAX_ROUTES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/doctor.mjs:L185` (process.env)

### `SMOKE_MODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L946` (process.env)
  - `backend/start.js:L29` (process.env)
  - `backend/tests/testServer.js:L15` (process.env)
  - `tests/e2e/playwright.config.mjs:L38` (process.env)
  - `tests/unit/startup-smoke-mode.test.mjs:L51` (process.env)

### `SMOKE_TARGET_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-login.mjs:L30` (process.env)

### `SOURCE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/db-top-tags.cjs:L4` (process.env)

### `SQLITE_BUSY_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L405` (process.env)

### `SQLITE_CACHE_SIZE_KB`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L408` (process.env)

### `SQLITE_DB_PATH`

- **Templates**:
  - `.env.example:219` = `backend/data/grantflow.dev.db`
  - `backend/env.example:11` = `backend/data/grantflow.dev.db`
- **Code references**:
  - `backend/db/index.js:L115` (process.env)
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L312` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L163` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L7` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L10` (process.env)
  - `backend/start.js:L32` (process.env)
  - `backend/tests/testServer.js:L20` (process.env)
  - `scripts/audit-section-metadata.mjs:L38` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L42` (process.env)
  - `scripts/crawler-smoke.mjs:L18` (process.env)

### `STARTUP_PROFILE_ORG_LINK_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1009` (process.env)
  - `backend/startup/selfHeal.js:L83` (process.env)

### `STARTUP_SMOKE_CRAWL_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2512` (process.env)
  - `backend/startup/backgroundServices.js:L116` (process.env)

### `STRIPE_MOCK`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/stripeService.js:L51–L107` (process.env)

### `STRIPE_SECRET_KEY`

- **Templates**:
  - `backend/env.example:86` = ``
- **Code references**:
  - `backend/services/stripeService.js:L9` (process.env)

### `STRIPE_WEBHOOK_SECRET`

- **Templates**:
  - `backend/env.example:87` = ``
- **Code references**:
  - `backend/services/stripeService.js:L14–L138` (process.env)

### `TEST_API_URL`

- **Templates**: (not present)
- **Code references**:
  - `tests/integration/grants-from-opportunity.test.mjs:L22–L115` (process.env)
  - `tests/manual/test-from-opportunity-comprehensive.mjs:L9` (process.env)

### `TEST_CONCURRENCY`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-unit-tests.mjs:L37` (process.env)

### `TEST_STATE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/opportunities-national-minimum.mjs:L139` (process.env)

### `TEST_ZIP`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/testServer.js:L93` (process.env)

### `TWILIO_ACCOUNT_SID`

- **Templates**:
  - `backend/env.example:74` = `ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L149` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L28` (process.env)
  - `backend/services/diagnosticsService.js:L357` (process.env)

### `TWILIO_AUTH_TOKEN`

- **Templates**:
  - `backend/env.example:75` = `your-twilio-auth-token`
- **Code references**:
  - `backend/routes/auth.js:L150` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L29` (process.env)
  - `backend/services/diagnosticsService.js:L357` (process.env)

### `TWILIO_FROM_NUMBER`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L152` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L36` (process.env)

### `TWILIO_MESSAGING_SERVICE_SID`

- **Templates**:
  - `backend/env.example:76` = `MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L151` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L36–L95` (process.env)

### `UNIT_TEST_CONCURRENCY`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-unit-tests.mjs:L37` (process.env)

### `UNIT_TEST_HARD_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-unit-tests.mjs:L54` (process.env)

### `UPLOADS_DIR`

- **Templates**:
  - `backend/env.example:42` = ``
- **Code references**:
  - `backend/routes/health.js:L200` (process.env)
  - `backend/server.js:L244` (process.env)
  - `backend/services/anyaOrchestrator.js:L1332` (process.env)
  - `backend/startup/bootstrap.js:L54` (process.env)
  - `backend/utils/uploadsPath.js:L24–L25` (process.env)
  - `tests/unit/release-hardening.test.mjs:L35–L44` (process.env)

### `UPLOADS_PERSIST_PREFIXES`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/uploadsPath.js:L38` (process.env)

### `UPLOAD_DIR`

- **Templates**: (not present)
- **Code references**:
  - `scripts/dev-start-geo-crawl.mjs:L40–L41` (process.env)

### `URL_VERIFICATION_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L186–L216` (process.env)
  - `backend/services/opportunityInserter.js:L59` (process.env)
  - `backend/startup/bootstrap.js:L396–L423` (process.env)

### `VERCEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L52` (process.env)
  - `scripts/ensure-build-natives.mjs:L90` (process.env)

### `VERCEL_ENV`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L295` (process.env)
  - `backend/utils/environment.js:L14–L24` (process.env)

### `VERCEL_GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L45` (process.env)
  - `backend/server.js:L1788` (process.env)
  - `backend/startup/backgroundServices.js:L309` (process.env)

### `VERIFY_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/geo-crawl-5zips.mjs:L19` (process.env)
  - `scripts/verification/health-verify.mjs:L20` (process.env)
  - `scripts/verification/uploads-persistence.mjs:L18` (process.env)
  - `scripts/verify-login.mjs:L5` (process.env)

### `VERIFY_BACKEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/geo-crawl-5zips.mjs:L18` (process.env)
  - `scripts/verification/health-verify.mjs:L19` (process.env)
  - `scripts/verification/owner-profile-access.mjs:L14` (process.env)
  - `scripts/verification/uploads-persistence.mjs:L17` (process.env)

### `VERIFY_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-login.mjs:L4` (process.env)

### `VERIFY_DB_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/db-evidence.mjs:L4` (process.env)
  - `scripts/verification/geo-crawl-5zips.mjs:L20` (process.env)
  - `scripts/verification/health-verify.mjs:L21` (process.env)
  - `scripts/verification/orphans-evidence.mjs:L4` (process.env)
  - `scripts/verification/profiles-integrity.mjs:L14` (process.env)

### `VERIFY_GEO_RUN_ID`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/ui-geocrawl-monitor.mjs:L20` (process.env)

### `VERIFY_PROFILE_ID`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/ui-health.mjs:L21` (process.env)
  - `scripts/verification/uploads-persistence.mjs:L19` (process.env)

### `VERIFY_UI_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/ui-geocrawl-monitor.mjs:L18` (process.env)
  - `scripts/verification/ui-health.mjs:L19` (process.env)
  - `scripts/verification/ui-missing-profiles-admin.mjs:L14` (process.env)
  - `scripts/verification/ui-paymentsheet.mjs:L16` (process.env)

### `VERIFY_UI_OUT_DIR`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/ui-geocrawl-monitor.mjs:L19` (process.env)
  - `scripts/verification/ui-health.mjs:L20` (process.env)
  - `scripts/verification/ui-missing-profiles-admin.mjs:L15` (process.env)
  - `scripts/verification/ui-paymentsheet.mjs:L17` (process.env)

### `VITE_ANYA_COPILOT_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L38` (import.meta.env)

### `VITE_ANYA_SCREENSHOT_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L39` (import.meta.env)

### `VITE_API_PROXY_TARGET`

- **Templates**:
  - `env.example:8` = `http://localhost:8080`
- **Code references**: (none)

### `VITE_API_URL`

- **Templates**:
  - `env.example:4` = `http://localhost:8080`
- **Code references**:
  - `src/api/client.js:L16` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L62–L127` (import.meta.env)
  - `src/config/env.js:L34` (import.meta.env)
  - `tmp/migration/grantflow-migration/src/api/client.js:L4` (import.meta.env)

### `VITE_APP_BASE`

- **Templates**:
  - `env.example:5` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L157` (process.env)
  - `backend/server.js:L565` (process.env)
  - `scripts/doctor.mjs:L81–L180` (process.env)
  - `src/components/auth/SessionExpiredDialog.jsx:L10` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L25` (import.meta.env)
  - `src/config/env.js:L33` (import.meta.env)
  - `src/utils/enforceBasename.js:L13` (import.meta.env)
  - `src/utils/index.js:L27` (import.meta.env)
  - `tests/e2e/playwright.config.mjs:L10` (process.env)
  - `tests/helpers/backendHarness.mjs:L53` (process.env)
  - `tests/smoke/playwright.config.mjs:L5` (process.env)
  - `tests/unit/anya-tasks.test.mjs:L39` (process.env)
  - `tests/unit/api-contracts.test.mjs:L57` (process.env)

### `VITE_ASSET_BASE`

- **Templates**:
  - `env.example:11` = `/grantflow/`
- **Code references**:
  - `scripts/doctor.mjs:L169` (process.env)

### `VITE_CANONICAL_HOST`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L35` (import.meta.env)
  - `src/utils/enforceCanonicalHost.js:L6` (import.meta.env)

### `VITE_CANONICAL_HOST_STRICT`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L36` (import.meta.env)
  - `src/utils/enforceCanonicalHost.js:L11` (import.meta.env)

### `VITE_DEV_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `src/pages/Login.jsx:L69` (import.meta.env)

### `VITE_ENABLE_CLICK_TRACER`

- **Templates**: (not present)
- **Code references**:
  - `src/components/shared/clickTracer.jsx:L5` (import.meta.env)

### `VITE_ENABLE_CLIENT_LOGS`

- **Templates**: (not present)
- **Code references**:
  - `src/utils/logger.js:L15` (import.meta.env)

### `VITE_FORCE_RAILWAY_API`

- **Templates**: (not present)
- **Code references**:
  - `src/components/auth/SocialSignInButtons.jsx:L123` (import.meta.env)
  - `src/config/env.js:L40–L107` (import.meta.env)

### `VITE_SHOULDERS_VNEXT`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L37` (import.meta.env)

### `VITE_SMOKE_MODE`

- **Templates**: (not present)
- **Code references**:
  - `tests/e2e/playwright.config.mjs:L39` (process.env)

### `VITE_SUPPORT_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `src/pages/Pricing.jsx:L280–L283` (import.meta.env)

### `VITE_SUPPORT_FAX`

- **Templates**: (not present)
- **Code references**:
  - `src/pages/Pricing.jsx:L288` (import.meta.env)

### `X_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-docs-local.mjs:L18` (process.env)

### `ZIP_COUNTY_MAP_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/geo/zipCountyResolver.js:L15–L15` (process.env)
