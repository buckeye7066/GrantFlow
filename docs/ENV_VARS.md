# ENV Vars Inventory

This file is **generated** by `node scripts/inventory-env.mjs`.
It enumerates environment variables referenced in code and/or present in example env files.

## Summary

- Total vars: **562**
- Vars referenced in code: **548**
- Vars present in env templates: **72**

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
| `AGENT_CONTROL_ADMIN_EMAIL` | Yes | No | Backend/Node |
| `ALERT_FAILURE_THRESHOLD` | Yes | No | Backend/Node |
| `ALERT_QUEUE_BACKLOG_THRESHOLD` | Yes | No | Backend/Node |
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
| `ANYA_FUNCTION_TEST_TIMEOUT_MS` | Yes | No | Backend/Node |
| `ANYA_GEO_CRAWL` | Yes | No | Backend/Node |
| `ANYA_HEALTH_INTERVAL_MS` | Yes | No | Backend/Node |
| `ANYA_ITEM_DISCOVERY` | Yes | No | Backend/Node |
| `ANYA_ITEM_DISCOVERY_LIMIT` | Yes | No | Backend/Node |
| `ANYA_ITEM_DISCOVERY_MIN_COUNT` | Yes | No | Backend/Node |
| `ANYA_MATCH_SCOUT` | Yes | No | Backend/Node |
| `ANYA_MATCH_SCOUT_CANDIDATE_LIMIT` | Yes | No | Backend/Node |
| `ANYA_MATCH_SCOUT_MAX_ALERTS_PER_PROFILE` | Yes | No | Backend/Node |
| `ANYA_MATCH_SCOUT_THRESHOLD` | Yes | No | Backend/Node |
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
| `AUTH_EMAIL_FROM` | Yes | No | Backend/Node |
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
| `AUTO_DISCOVERY_DAILY_ENABLED` | Yes | Yes | Backend/Node |
| `AUTO_DISCOVERY_DAILY_HOUR` | Yes | Yes | Backend/Node |
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
| `BEHAVIOR_LEARNING_ENABLED` | Yes | No | Backend/Node |
| `BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE` | Yes | No | Backend/Node |
| `BILLING_AUTOMATION_ENABLED` | Yes | No | Backend/Node |
| `BILLING_CYCLE_INTERVAL_MS` | Yes | No | Backend/Node |
| `BILLING_OWNER_CC` | Yes | No | Backend/Node |
| `BILLING_SECOND_NOTICE_DAYS` | Yes | No | Backend/Node |
| `BILLING_SUSPEND_DAYS` | Yes | No | Backend/Node |
| `BLOCKLIST_INGEST_TOKEN` | Yes | No | Backend/Node |
| `BRAVE_SEARCH_API_KEY` | Yes | No | Backend/Node |
| `BROADCAST_FROM_EMAIL` | Yes | No | Backend/Node |
| `BUILD_TIME` | Yes | No | Backend/Node |
| `BUILD_TIMESTAMP` | Yes | No | Backend/Node |
| `BULK_POPULATE_KEY` | Yes | Yes | Backend/Node |
| `CI` | Yes | No | Backend/Node |
| `COMMIT_AUDIT_OUT_PATH` | Yes | No | Backend/Node |
| `COMMIT_SHA` | Yes | No | Backend/Node |
| `COMPREHENSIVE_GEO_JOB_TIMEOUT_MS` | Yes | No | Backend/Node |
| `COMPREHENSIVE_JOB_TIMEOUT_MS` | Yes | No | Backend/Node |
| `COMPUTERNAME` | Yes | No | Backend/Node |
| `CONFIRM` | Yes | No | Backend/Node |
| `CONNECTOR_INGEST_MAX_TERMS` | Yes | No | Backend/Node |
| `CORE_TIMEOUT_MINUTES` | Yes | No | Backend/Node |
| `CORS_ORIGIN` | Yes | Yes | Backend/Node |
| `COUNTRIES` | Yes | No | Backend/Node |
| `COUNTY_FUNDING_CRAWLER_ENABLED` | Yes | No | Backend/Node |
| `CRAWLER_COVERAGE_FAILURE_THRESHOLD` | Yes | No | Backend/Node |
| `CRAWLER_DATA_DIR` | Yes | No | Backend/Node |
| `CRAWLER_DISPATCH_BASE_DELAY_MS` | Yes | No | Backend/Node |
| `CRAWLER_DISPATCH_MAX_ATTEMPTS` | Yes | No | Backend/Node |
| `CRAWLER_DISPATCH_MAX_DELAY_MS` | Yes | No | Backend/Node |
| `CRAWLER_FLOOR` | Yes | No | Backend/Node |
| `CRAWLER_JOB_STUCK_THRESHOLD_MS` | Yes | No | Backend/Node |
| `CRAWLER_JOB_TIMEOUT_MS` | Yes | No | Backend/Node |
| `CRAWLER_MAX_CONCURRENCY` | Yes | No | Backend/Node |
| `CRAWLER_MAX_RETRY_DELAY` | Yes | No | Backend/Node |
| `CRAWLER_MAX_SOURCES` | Yes | No | Backend/Node |
| `CRAWLER_MIN_FLOOR` | Yes | No | Backend/Node |
| `CRAWLER_OS_ALLOW_LEGACY` | Yes | No | Backend/Node |
| `CRAWLER_PROFILE_ID` | Yes | No | Backend/Node |
| `CRAWLER_RETRY_BASE_DELAY` | Yes | No | Backend/Node |
| `CRAWLER_STALE_CLEANUP_INTERVAL_MS` | Yes | No | Backend/Node |
| `CRAWLER_STALE_DAYS` | Yes | No | Backend/Node |
| `CRAWLER_STALE_HEARTBEAT_MS` | Yes | No | Backend/Node |
| `CRAWLER_STALE_RUNNING_MS` | Yes | No | Backend/Node |
| `CRAWL_FALLBACK_RESERVE_MS` | Yes | No | Backend/Node |
| `CRAWL_TIME_BUDGET_MS` | Yes | No | Backend/Node |
| `CRAWL_TOTAL_BUDGET_MS` | Yes | No | Backend/Node |
| `CURSOR_PROJECT_DIR` | Yes | No | Backend/Node |
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
| `DISABLE_BACKGROUND_SERVICES` | Yes | No | Backend/Node |
| `DISABLE_SEEDING` | Yes | No | Backend/Node |
| `DISCOVER_ALL_THROTTLE_MIN` | Yes | No | Backend/Node |
| `DOMAIN_CORPUS_CRAWL_TIMEOUT_MS` | Yes | No | Backend/Node |
| `DRY_RUN` | Yes | No | Backend/Node |
| `E2E_BASE_PATH` | Yes | No | Backend/Node |
| `E2E_BASE_URL` | Yes | No | Backend/Node |
| `E2E_PORT` | Yes | No | Backend/Node |
| `ECF_LIVE_FETCH_TIMEOUT_MS` | Yes | No | Backend/Node |
| `ECF_LIVE_FETCH_USER_AGENT` | Yes | No | Backend/Node |
| `EMAIL_FROM` | Yes | No | Backend/Node |
| `EMAIL_GRANTS_INGEST_TOKEN` | Yes | No | Backend/Node |
| `EMAIL_GRANTS_SYNC_CRON` | Yes | No | Backend/Node |
| `EMAIL_GRANTS_SYNC_ENABLED` | Yes | No | Backend/Node |
| `EMAIL_GRANTS_SYNC_TOP` | Yes | No | Backend/Node |
| `EMAIL_GRANTS_SYNC_TZ` | Yes | No | Backend/Node |
| `ENABLE_ASSISTANCE_DIRECTORIES_SEED` | No | Yes |  |
| `ENABLE_CENSUS_GEO` | Yes | No | Backend/Node |
| `ENABLE_MIN_NATIONAL_ENSURE` | Yes | Yes | Backend/Node |
| `ENABLE_REGISTRY_VERIFICATION` | Yes | No | Backend/Node |
| `ENFORCE_PROFILE_SCOPED_PIPELINE` | Yes | No | Backend/Node |
| `ENFORCE_RELEVANCE_FLOOR` | Yes | No | Backend/Node |
| `FEATURE_ANYA_TOOLS` | Yes | No | Backend/Node |
| `FEATURE_AUTO_REPAIR` | Yes | No | Backend/Node |
| `FEATURE_CRAWLER_RETRIES` | Yes | No | Backend/Node |
| `FEATURE_DETAILED_MATCHING` | Yes | No | Backend/Node |
| `FEATURE_GEO_CRAWL` | Yes | No | Backend/Node |
| `FROM_EMAIL` | Yes | Yes | Backend/Node |
| `FRONTEND_BASE_URL` | Yes | No | Backend/Node |
| `FRONTEND_COMPONENTS_PATH` | Yes | No | Backend/Node |
| `FRONTEND_URL` | Yes | No | Backend/Node |
| `FUNDING_APIS_REQUIRE_KEYS` | Yes | No | Backend/Node |
| `FUNDING_TRACE_MAX_AGE_YEARS` | Yes | No | Backend/Node |
| `FUNDING_TRACE_MIN_AMOUNT` | Yes | No | Backend/Node |
| `GEO_BATCH_SIZE` | Yes | No | Backend/Node |
| `GEO_COUNTIES_BY_STATE_PATH` | Yes | Yes | Backend/Node |
| `GEO_CRAWL_FIXTURES_DIR` | Yes | No | Backend/Node |
| `GEO_CRAWL_HEARTBEAT_MS` | Yes | No | Backend/Node |
| `GEO_MIN_SOURCES_PER_ZIP` | Yes | No | Backend/Node |
| `GEO_MIN_ZIP_COORDINATES` | Yes | No | Backend/Node |
| `GEO_RATE_LIMIT_MS` | Yes | No | Backend/Node |
| `GEO_RESUME_WINDOW_DAYS` | Yes | No | Backend/Node |
| `GEO_SCOPE` | Yes | No | Backend/Node |
| `GEO_TIMEOUT_MS` | Yes | No | Backend/Node |
| `GEO_ZIP_COORDINATES_PATH` | Yes | Yes | Backend/Node |
| `GF_ADMIN_EMAIL` | Yes | No | Backend/Node |
| `GF_ADMIN_PASSWORD` | Yes | No | Backend/Node |
| `GF_API` | Yes | No | Backend/Node |
| `GF_COUNTRIES` | Yes | No | Backend/Node |
| `GF_DEDUPE_STRATEGIES` | Yes | No | Backend/Node |
| `GF_GRANT_LIMIT` | Yes | No | Backend/Node |
| `GF_MAX_WAIT_MS` | Yes | No | Backend/Node |
| `GF_POLL_INTERVAL_MS` | Yes | No | Backend/Node |
| `GF_TOKEN` | Yes | No | Backend/Node |
| `GITHUB_ACTIONS` | Yes | No | Backend/Node |
| `GITHUB_REPO` | Yes | No | Backend/Node |
| `GITHUB_TOKEN` | Yes | No | Backend/Node |
| `GIT_BRANCH` | Yes | No | Backend/Node |
| `GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `GMAIL_OAUTH_CLIENT_ID` | Yes | No | Backend/Node |
| `GMAIL_OAUTH_CLIENT_SECRET` | Yes | No | Backend/Node |
| `GMAIL_OAUTH_REFRESH_TOKEN` | Yes | No | Backend/Node |
| `GOOGLE_API_KEY` | Yes | No | Backend/Node |
| `GOOGLE_MAPS_API_KEY` | Yes | No | Backend/Node |
| `GOOGLE_SEARCH_CX` | Yes | No | Backend/Node |
| `GRANTFLOW_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `GRANTFLOW_API` | Yes | No | Backend/Node |
| `GRANTFLOW_BASE_URL` | Yes | No | Backend/Node |
| `GRANTFLOW_BEARER_TOKEN` | Yes | No | Backend/Node |
| `GRANTFLOW_DRY_RUN` | Yes | No | Backend/Node |
| `GRANTFLOW_PROFILE_ID` | Yes | No | Backend/Node |
| `GRANTFLOW_PROFILE_IDS` | Yes | No | Backend/Node |
| `GRANTFLOW_REPO_ROOT` | Yes | No | Backend/Node |
| `GRANTFLOW_SEED_MODE` | Yes | No | Backend/Node |
| `GRANTFLOW_SIGNIN_URL` | Yes | No | Backend/Node |
| `GRANTFLOW_SKIP_VERIFICATION_GATE` | Yes | No | Backend/Node |
| `GRANTFLOW_TEST_EMAIL` | Yes | No | Backend/Node |
| `GRANTFLOW_TEST_PASSWORD` | Yes | No | Backend/Node |
| `GRANTFLOW_TIMEOUT_MS` | Yes | No | Backend/Node |
| `GRANTFLOW_TOKEN` | Yes | No | Backend/Node |
| `GRANTS_GOV_API_KEY` | Yes | No | Backend/Node |
| `HAMILTON_ADMIN_EMAIL` | Yes | No | Backend/Node |
| `HAMILTON_ADMIN_VAULT_PROFILE_ID` | Yes | No | Backend/Node |
| `HAMILTON_AUTOPILOT_MAX_PAGES` | Yes | No | Backend/Node |
| `HAMILTON_AUTOPILOT_NAV_TIMEOUT_MS` | Yes | No | Backend/Node |
| `HAMILTON_AUTOPILOT_STEP_TIMEOUT_MS` | Yes | No | Backend/Node |
| `HAMILTON_BATCH_SIZE` | Yes | No | Backend/Node |
| `HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST` | Yes | No | Backend/Node |
| `HAMILTON_BROWSER_STORAGE_DIR` | Yes | No | Backend/Node |
| `HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT` | Yes | No | Backend/Node |
| `HAMILTON_CLOUD_LOGIN_ENABLED` | Yes | No | Backend/Node |
| `HAMILTON_CLOUD_LOGIN_PROVIDER` | Yes | No | Backend/Node |
| `HAMILTON_ENABLE_BROWSER_AUTOMATION` | Yes | No | Backend/Node |
| `HAMILTON_PACKET_STORAGE_DIR` | Yes | No | Backend/Node |
| `HAMILTON_RUN_ON_SCHEDULE` | Yes | No | Backend/Node |
| `HAMILTON_SCHEDULE_BATCH_SIZE` | Yes | No | Backend/Node |
| `HAMILTON_SCHEDULE_INTERVAL_MS` | Yes | No | Backend/Node |
| `HAMILTON_SIGNUP_NAV_TIMEOUT_MS` | Yes | No | Backend/Node |
| `HAMILTON_SIGNUP_STEP_TIMEOUT_MS` | Yes | No | Backend/Node |
| `HAMILTON_SIGNUP_VERIFY_POLL_MS` | Yes | No | Backend/Node |
| `HAMILTON_SIGNUP_VERIFY_WAIT_MS` | Yes | No | Backend/Node |
| `HAMILTON_SUGGEST_MAX_RETRIES` | Yes | No | Backend/Node |
| `HAMILTON_SUGGEST_MODEL` | Yes | No | Backend/Node |
| `HAMILTON_SUGGEST_TIMEOUT_MS` | Yes | No | Backend/Node |
| `HAMILTON_VAULT_UNLOCK_TTL_MS` | Yes | No | Backend/Node |
| `HAMILTON_WEEKLY_DIGEST_ENABLED` | Yes | No | Backend/Node |
| `HAMILTON_WEEKLY_DIGEST_HOUR_ET` | Yes | No | Backend/Node |
| `HOME` | Yes | No | Backend/Node |
| `HOSTNAME` | Yes | No | Backend/Node |
| `HOURS_LOOKBACK` | Yes | No | Backend/Node |
| `IMPECCABLE_CONTEXT_DIR` | Yes | No | Backend/Node |
| `IMPECCABLE_CRITIQUE_META` | Yes | No | Backend/Node |
| `IMPECCABLE_HOOK_DEBUG` | Yes | No | Backend/Node |
| `IMPECCABLE_HOOK_DEPTH` | Yes | No | Backend/Node |
| `IMPECCABLE_HOOK_DISABLED` | Yes | No | Backend/Node |
| `IMPECCABLE_LIVE_APPLY_EVENT_HARD_TIMEOUT_MS` | Yes | No | Backend/Node |
| `IMPECCABLE_LIVE_APPLY_EVENT_SOFT_DEADLINE_MS` | Yes | No | Backend/Node |
| `IMPECCABLE_LIVE_COPY_AGENT_TIMEOUT_MS` | Yes | No | Backend/Node |
| `IMPECCABLE_LIVE_DEBUG_EVENTS` | Yes | No | Backend/Node |
| `IMPECCABLE_LIVE_SVELTE_COMPONENT` | Yes | No | Backend/Node |
| `IMPECCABLE_NO_UPDATE_CHECK` | Yes | No | Backend/Node |
| `IMPECCABLE_PALETTE_SEED` | Yes | No | Backend/Node |
| `IMPECCABLE_UPDATE_CACHE` | Yes | No | Backend/Node |
| `IMPECCABLE_UPDATE_HOST` | Yes | No | Backend/Node |
| `INGEST_CONNECTORS` | Yes | No | Backend/Node |
| `INTERNAL_API_URL` | Yes | No | Backend/Node |
| `INTERNAL_BASE_URL` | Yes | No | Backend/Node |
| `ITEM_SUGGESTIONS_PER_PROFILE` | Yes | No | Backend/Node |
| `JOHN_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `JOHN_AI_DRAFTING` | Yes | No | Backend/Node |
| `JOHN_AI_MAX_RETRIES` | Yes | No | Backend/Node |
| `JOHN_AI_MODEL` | Yes | No | Backend/Node |
| `JOHN_AI_TIMEOUT_MS` | Yes | No | Backend/Node |
| `JOHN_MAX_DRAFTS_PER_24H` | Yes | No | Backend/Node |
| `JOHN_PHYSICAL_ADDRESS` | Yes | No | Backend/Node |
| `JOHN_WEB_RESEARCH` | Yes | No | Backend/Node |
| `JWT_SECRET` | Yes | No | Backend/Node |
| `LAPTOP_CONNECTOR_API` | Yes | No | Backend/Node |
| `LAPTOP_CONNECTOR_MAX_RETRIES` | Yes | No | Backend/Node |
| `LAPTOP_CONNECTOR_MAX_TEXT` | Yes | No | Backend/Node |
| `LAPTOP_CONNECTOR_MODEL` | Yes | No | Backend/Node |
| `LAPTOP_CONNECTOR_TIMEOUT_MS` | Yes | No | Backend/Node |
| `LAPTOP_CONNECTOR_TOKEN` | Yes | No | Backend/Node |
| `LARRY_ENABLED` | Yes | No | Backend/Node |
| `LARRY_RUN_ON_SCHEDULE` | Yes | No | Backend/Node |
| `LARRY_RUN_ON_STARTUP` | Yes | No | Backend/Node |
| `LEGACY_GRANT_ONLY_EXCLUDES_MATCHING` | Yes | No | Backend/Node |
| `LIMIT` | Yes | No | Backend/Node |
| `LIMIT_OPPS_PER_PROFILE` | Yes | No | Backend/Node |
| `LINK_VERIFICATION_BATCH` | Yes | No | Backend/Node |
| `LINK_VERIFICATION_INTERVAL_MS` | Yes | No | Backend/Node |
| `LOG_BUFFER_SIZE` | Yes | No | Backend/Node |
| `LOG_LEVEL` | Yes | Yes | Backend/Node |
| `MAINTENANCE_ESTIMATED_MINUTES` | Yes | No | Backend/Node |
| `MAINTENANCE_GRACE_MINUTES` | Yes | No | Backend/Node |
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
| `MIGRATE_VERIFY_COUNTS` | Yes | No | Backend/Node |
| `MIN_NATIONAL_OPPORTUNITIES` | Yes | No | Backend/Node |
| `MIN_NATIONAL_VISIBLE` | Yes | No | Backend/Node |
| `MODE` | Yes | No | Frontend (Vite) |
| `MONDAY_PORTAL_REMINDER_ENABLED` | Yes | No | Backend/Node |
| `MONDAY_PORTAL_REMINDER_HOUR_ET` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_ENABLED` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_DEPTH` | Yes | No | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_URLS` | Yes | No | Backend/Node |
| `NIGHTLY_MAINTENANCE_ENABLED` | Yes | No | Backend/Node |
| `NIGHTLY_MAINTENANCE_HOUR_ET` | Yes | No | Backend/Node |
| `NIGHTLY_MAINTENANCE_MINUTES` | Yes | No | Backend/Node |
| `NIH_LIMIT` | Yes | No | Backend/Node |
| `NIH_TEXT` | Yes | No | Backend/Node |
| `NODE_ENV` | Yes | Yes | Backend/Node |
| `NOFO_FETCH_TIMEOUT_MS` | Yes | No | Backend/Node |
| `NOFO_PARSE_MAX_TEXT_CHARS` | Yes | No | Backend/Node |
| `OCR_PDF_DPI` | Yes | No | Backend/Node |
| `OCR_PDF_MAX_PAGES` | Yes | No | Backend/Node |
| `OCR_PROVIDER` | Yes | No | Backend/Node |
| `ONBOARDING_VERIFY_BASE` | Yes | No | Backend/Node |
| `OPENAI_API_KEY` | Yes | Yes | Backend/Node |
| `OPENAI_MAX_RETRIES` | Yes | No | Backend/Node |
| `OPENAI_MODEL` | Yes | No | Backend/Node |
| `OPENAI_TIMEOUT_MS` | Yes | No | Backend/Node |
| `OPPORTUNITY_INSERT_VERIFY_URL` | Yes | No | Backend/Node |
| `OPPORTUNITY_MIN_COUNT` | Yes | No | Backend/Node |
| `OPPORTUNITY_STALE_DAYS` | Yes | No | Backend/Node |
| `ORPHAN_MAINTENANCE_CONFIRM` | Yes | No | Backend/Node |
| `OWNER_ALIAS_EMAIL` | Yes | No | Backend/Node |
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
| `PHASE5_JOB_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PHASE5_SERVER_READY_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PIPELINE_INSERT_RELEVANCE_FLOOR` | Yes | No | Backend/Node |
| `PIPELINE_JOB_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PIPELINE_PURGE_RELEVANCE_FLOOR` | Yes | No | Backend/Node |
| `PIPELINE_RELEVANCE_FLOOR` | Yes | No | Backend/Node |
| `PIPELINE_SLOW_MS` | Yes | No | Backend/Node |
| `PIPELINE_TIMEOUT_MS` | Yes | No | Backend/Node |
| `PIPELINE_TRUSTED_RELEVANCE_FLOOR` | Yes | No | Backend/Node |
| `PORT` | Yes | Yes | Backend/Node |
| `PORTAL_SYNC_LLM_EXTRACT` | Yes | No | Backend/Node |
| `POSTGRES_DB` | Yes | No | Backend/Node |
| `POSTGRES_HOST` | Yes | No | Backend/Node |
| `POSTGRES_PASSWORD` | Yes | No | Backend/Node |
| `POSTGRES_PORT` | Yes | No | Backend/Node |
| `POSTGRES_USER` | Yes | No | Backend/Node |
| `PREVIEW_PORT` | Yes | No | Backend/Node |
| `PRICING_AUTO_DISCOUNTS_ENABLED` | Yes | No | Backend/Node |
| `PRICING_DISCOUNTS_ENABLED` | Yes | No | Backend/Node |
| `PRICING_MAX_TOTAL_DISCOUNT_PERCENT` | Yes | No | Backend/Node |
| `PRICING_REQUIRE_ADMIN_APPROVAL` | Yes | No | Backend/Node |
| `PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS` | Yes | No | Backend/Node |
| `PROBE_BASE_URL` | Yes | No | Backend/Node |
| `PROD` | Yes | No | Frontend (Vite) |
| `PROFILE_ID` | Yes | No | Backend/Node |
| `PROFILE_SCOPE_CI_STRICT` | Yes | No | Backend/Node |
| `PROFILE_SCOPE_STRICT` | Yes | No | Backend/Node |
| `PROFILE_TAXONOMY_DEBUG` | Yes | No | Backend/Node |
| `PUBLIC_APP_URL` | Yes | No | Backend/Node |
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
| `ROBERT_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `ROBERT_ALLOW_LIVE_WEB` | Yes | No | Backend/Node |
| `ROBERT_ALLOW_SOURCE_DISCOVERY` | Yes | No | Backend/Node |
| `ROBERT_AUTO_INGEST_VERIFIED` | Yes | No | Backend/Node |
| `ROBERT_CONTACTS_MAILBOX` | Yes | No | Backend/Node |
| `ROBERT_ENABLED` | Yes | No | Backend/Node |
| `ROBERT_JOHN_DEFAULT_LEAD_SCORE` | Yes | No | Backend/Node |
| `ROBERT_JOHN_MAX_LEADS_PER_24H` | Yes | No | Backend/Node |
| `ROBERT_MODE` | Yes | No | Backend/Node |
| `ROBERT_SCAN_EMAIL_CONTACTS` | Yes | No | Backend/Node |
| `ROBERT_SCHEDULED_MODE` | Yes | No | Backend/Node |
| `RUNTIME_SECRETS_KEY` | Yes | No | Backend/Node |
| `RUN_GEO_CRAWL` | Yes | No | Backend/Node |
| `RUN_ITEM_CRAWLERS` | Yes | No | Backend/Node |
| `RUN_SQLITE_MIGRATION` | Yes | No | Backend/Node |
| `SAM_AUTO_FIX_SAFE` | Yes | No | Backend/Node |
| `SAM_CHECK_TIMEOUT_MS` | Yes | No | Backend/Node |
| `SAM_ENABLED` | Yes | No | Backend/Node |
| `SAM_GOV_API_BASE_URL` | Yes | No | Backend/Node |
| `SAM_GOV_API_KEY` | Yes | No | Backend/Node |
| `SAM_GOV_KEY` | Yes | No | Backend/Node |
| `SAM_GOV_PUBLIC_API_KEY` | Yes | No | Backend/Node |
| `SAM_HTTP_PROBE_TIMEOUT_MS` | Yes | No | Backend/Node |
| `SAM_MAX_FIXES_PER_RUN` | Yes | No | Backend/Node |
| `SAM_MODE` | Yes | No | Backend/Node |
| `SAM_RUN_ON_SCHEDULE` | Yes | No | Backend/Node |
| `SAM_RUN_ON_STARTUP` | Yes | No | Backend/Node |
| `SAM_SCHEDULE` | Yes | No | Backend/Node |
| `SCHOOL_PORTAL_VERIFY_BASE` | Yes | No | Backend/Node |
| `SEARXNG_ENGINES` | Yes | No | Backend/Node |
| `SEARXNG_URL` | Yes | No | Backend/Node |
| `SEED_KEY` | Yes | No | Backend/Node |
| `SEED_PATH` | Yes | No | Backend/Node |
| `SENDGRID_API_KEY` | Yes | No | Backend/Node |
| `SENTRY_DSN` | No | Yes |  |
| `SERVICE_APPLICATION_EMAIL` | Yes | No | Backend/Node |
| `SERVICE_CATALOG_SEED_TTL_MS` | Yes | No | Backend/Node |
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
| `SMS_CONSENT_MESSAGE` | Yes | No | Backend/Node |
| `SMS_CONSENT_PENDING_EXPIRE_DAYS` | Yes | No | Backend/Node |
| `SMTP_HOST` | Yes | No | Backend/Node |
| `SOURCE` | Yes | No | Backend/Node |
| `SQLITE_BUSY_TIMEOUT_MS` | Yes | No | Backend/Node |
| `SQLITE_CACHE_SIZE_KB` | Yes | No | Backend/Node |
| `SQLITE_DB_PATH` | Yes | Yes | Backend/Node |
| `SQLITE_PATH` | Yes | No | Backend/Node |
| `STARTUP_PROFILE_JOB_REPAIR_LIMIT` | Yes | No | Backend/Node |
| `STARTUP_PROFILE_ORG_LINK_LIMIT` | Yes | No | Backend/Node |
| `STARTUP_SMOKE_CRAWL_ENABLED` | Yes | No | Backend/Node |
| `STRIPE_MOCK` | Yes | No | Backend/Node |
| `STRIPE_SECRET_KEY` | Yes | Yes | Backend/Node |
| `STRIPE_WEBHOOK_SECRET` | Yes | Yes | Backend/Node |
| `SWEEP_DEBUG` | Yes | No | Backend/Node |
| `TEST_API_URL` | Yes | No | Backend/Node |
| `TEST_CONCURRENCY` | Yes | No | Backend/Node |
| `TEST_STATE` | Yes | No | Backend/Node |
| `TEST_ZIP` | Yes | No | Backend/Node |
| `TWILIO_ACCOUNT_SID` | Yes | Yes | Backend/Node |
| `TWILIO_AUTH_TOKEN` | Yes | Yes | Backend/Node |
| `TWILIO_FROM_NUMBER` | Yes | No | Backend/Node |
| `TWILIO_MESSAGING_SERVICE_SID` | Yes | Yes | Backend/Node |
| `TWILIO_PUBLIC_BASE_URL` | Yes | No | Backend/Node |
| `TWILIO_VALIDATE_SIGNATURE` | Yes | No | Backend/Node |
| `UNIT_TEST_CONCURRENCY` | Yes | No | Backend/Node |
| `UNIT_TEST_HARD_TIMEOUT_MS` | Yes | No | Backend/Node |
| `UPLOADS_DIR` | Yes | Yes | Backend/Node |
| `UPLOADS_PERSIST_PREFIXES` | Yes | No | Backend/Node |
| `UPLOAD_DIR` | Yes | No | Backend/Node |
| `URL_VERIFICATION_ENABLED` | Yes | No | Backend/Node |
| `USERPROFILE` | Yes | No | Backend/Node |
| `VEHICLES_INGEST_TOKEN` | Yes | No | Backend/Node |
| `VERCEL` | Yes | No | Backend/Node |
| `VERCEL_ENV` | Yes | No | Backend/Node |
| `VERCEL_GIT_COMMIT_SHA` | Yes | No | Backend/Node |
| `VERIFICATION_CACHE_MAX_ENTRIES` | Yes | No | Backend/Node |
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
| `VITE_API_URL` | Yes | No | Frontend (Vite) |
| `VITE_APP_BASE` | Yes | Yes | Used in both backend + frontend |
| `VITE_ASSET_BASE` | Yes | No | Backend/Node |
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
| `WEEKLY_VERIFY_CHUNKS` | Yes | No | Backend/Node |
| `X_ADMIN_TOKEN` | Yes | No | Backend/Node |
| `YANA_ALLOW_LIVE_WEB` | Yes | No | Backend/Node |
| `YANA_CAP_WINDOW_HOURS` | Yes | No | Backend/Node |
| `YANA_DAILY_LEAD_CAP` | Yes | No | Backend/Node |
| `YANA_ENABLED` | Yes | No | Backend/Node |
| `YANA_ENRICH_CONCURRENCY` | Yes | No | Backend/Node |
| `YANA_LEADS_ENABLED` | Yes | No | Backend/Node |
| `YANA_LEADS_RUN_ON_SCHEDULE` | Yes | No | Backend/Node |
| `YANA_LEADS_RUN_ON_STARTUP` | Yes | No | Backend/Node |
| `YANA_QUALIFY_THRESHOLD` | Yes | No | Backend/Node |
| `YANA_RUN_ON_SCHEDULE` | Yes | No | Backend/Node |
| `YANA_RUN_ON_STARTUP` | Yes | No | Backend/Node |
| `YANA_WEB_CSV_FEED_URL` | Yes | No | Backend/Node |
| `YANA_WEB_JSON_FEED_URL` | Yes | No | Backend/Node |
| `ZIP_COUNTY_MAP_PATH` | Yes | No | Backend/Node |

## Usage locations (file + line ranges)

### `ACCESS_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L26` (process.env)

### `ADMIN_EMAIL`

- **Templates**:
  - `.env.example:32` = `buckeye7066@gmail.com`
  - `backend/env.example:35` = `admin@grantflow.local`
- **Code references**:
  - `backend/config/constants.js:L11` (process.env)
  - `backend/scripts/seed-deterministic.mjs:L50` (process.env)
  - `backend/server.js:L174` (process.env)
  - `backend/services/agentControl/agentAdapters/samAgentAdapter.js:L37` (process.env)
  - `backend/services/agentControl/agentControlOrchestrator.js:L114` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L247` (process.env)
  - `backend/services/anyaOrchestrator.js:L23` (process.env)
  - `backend/services/email.js:L250` (process.env)
  - `backend/tests/samCanonicalAdminEmail.test.js:L31–L80` (process.env)
  - `scripts/ensure-admin-user.mjs:L19` (process.env)
  - `tests/e2e/playwright.config.mjs:L34` (process.env)

### `ADMIN_EMAILS`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/constants.js:L18` (process.env)

### `ADMIN_HEALTH_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/middleware/authIdentity.js:L55` (process.env)
  - `backend/services/codeGuardService.js:L82` (process.env)

### `ADMIN_LOGIN_EVENT_BUFFER`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/adminLoginEventStore.js:L6` (process.env)

### `ADMIN_NAME`

- **Templates**:
  - `.env.example:36` = `Admin User`
  - `backend/env.example:34` = `Local Admin`
- **Code references**:
  - `backend/scripts/seed-deterministic.mjs:L51` (process.env)
  - `backend/server.js:L160` (process.env)
  - `scripts/ensure-admin-user.mjs:L21` (process.env)
  - `tests/e2e/playwright.config.mjs:L35` (process.env)

### `ADMIN_PHONE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/ensure-admin-user.mjs:L20` (process.env)

### `ADMIN_SELF_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAdminTools.js:L1313` (process.env)

### `ADMIN_TOKEN`

- **Templates**:
  - `backend/env.example:33` = ``
- **Code references**:
  - `backend/routes/anya.js:L25` (process.env)
  - `backend/routes/authMe.js:L286` (process.env)
  - `backend/routes/blocklist.js:L35` (process.env)
  - `backend/routes/emailGrants.js:L31` (process.env)
  - `backend/routes/john.js:L68` (process.env)
  - `backend/routes/robert.js:L62` (process.env)
  - `backend/routes/sam.js:L159` (process.env)
  - `backend/routes/vehicles.js:L37` (process.env)
  - `backend/scripts/check-crawler-results.mjs:L25` (process.env)
  - `backend/server.js:L159–L1711` (process.env)
  - `backend/services/anyaAdminTools.js:L1350` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L214` (process.env)
  - `backend/services/anyaStartupAudit.js:L43` (process.env)
  - `backend/services/anyaToolRegistry.js:L3916–L4089` (process.env)
  - `backend/services/codeGuardService.js:L83` (process.env)
  - `backend/services/sam/samHttpProbe.js:L54` (process.env)
  - `backend/tests/samHttpProbe.test.js:L9–L15` (process.env)
  - `backend/tests/testServer.js:L18` (process.env)
  - `scripts/_lib/secrets.mjs:L21` (process.env)
  - `scripts/admin-dedupe-all-profiles.mjs:L17` (process.env)
  - `scripts/dedupe-profiles.mjs:L29` (process.env)
  - `scripts/doctor.mjs:L79` (process.env)
  - `scripts/hamilton-import-chrome-csv.mjs:L32` (process.env)
  - `scripts/hamilton-route-chrome-csv.mjs:L48` (process.env)
  - `scripts/run-all-real-crawlers.mjs:L5` (process.env)
  - `scripts/runtime-crawl-local.mjs:L129` (process.env)
  - `scripts/smoke-docs-local.mjs:L18` (process.env)
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L28` (process.env)
  - `scripts/verify-prod-issues.mjs:L12` (process.env)
  - `tests/helpers/backendHarness.mjs:L82` (process.env)
  - `tests/integration/grants-from-opportunity.test.mjs:L23` (process.env)
  - `tests/manual/test-from-opportunity-comprehensive.mjs:L10` (process.env)
  - `tests/smoke/admin-tools-button-live.spec.mjs:L23` (process.env)
  - `tests/unit/api-contracts.test.mjs:L77` (process.env)
  - `tools/laptop-connector/capture.js:L146` (process.env)
  - `tools/laptop-connector/scan.js:L102` (process.env)

### `AGENT_CONTROL_ADMIN_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L173` (process.env)
  - `backend/services/agentControl/agentAdapters/samAgentAdapter.js:L36` (process.env)
  - `backend/services/agentControl/agentControlOrchestrator.js:L113` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L246` (process.env)
  - `backend/services/anyaOrchestrator.js:L22` (process.env)
  - `backend/tests/samCanonicalAdminEmail.test.js:L30–L70` (process.env)

### `ALERT_FAILURE_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/dataReadinessService.js:L206` (process.env)

### `ALERT_QUEUE_BACKLOG_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/dataReadinessService.js:L185` (process.env)

### `ALLOW_AUTO_ROUTE_GENERATION`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaTestRepair.js:L20` (process.env)
  - `tests/unit/security-hardening.test.mjs:L44–L70` (process.env)

### `ALLOW_DESTRUCTIVE_SEED`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/seed-deterministic.mjs:L39` (process.env)

### `ALLOW_DEV_FILESYSTEM_AUDIT_LOGS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousCrawler.js:L646` (process.env)
  - `backend/services/anyaAutonomousFunctionRunner.js:L64–L363` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L91–L712` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L118` (process.env)
  - `backend/services/nationalPrograms/audit.js:L45` (process.env)

### `ALLOW_EPHEMERAL_SQLITE`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L767` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L10` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L13` (process.env)
  - `backend/server.js:L261` (process.env)
  - `backend/startup/bootstrap.js:L435` (process.env)

### `ALLOW_EPHEMERAL_UPLOADS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L237` (process.env)
  - `backend/server.js:L228` (process.env)
  - `backend/startup/bootstrap.js:L27` (process.env)

### `ALLOW_LEGACY_PROFILE_TOKEN`

- **Templates**:
  - `backend/env.example:37` = `false`
- **Code references**:
  - `backend/middleware/authIdentity.js:L246` (process.env)
  - `backend/server.js:L1629` (process.env)
  - `tests/unit/authIdentity.test.mjs:L285–L337` (process.env)

### `ALLOW_SQLITE_IN_PROD`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L718` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L11` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L14` (process.env)

### `ANALYTICS_WRITE_KEY`

- **Templates**:
  - `backend/env.example:179` = ``
- **Code references**: (none)

### `ANTHROPIC_API_KEY`

- **Templates**:
  - `backend/env.example:92` = `sk-ant-your-anthropic-key`
- **Code references**:
  - `backend/routes/admin.js:L578–L581` (process.env)
  - `backend/routes/ai.js:L57–L61` (process.env)
  - `backend/routes/anya.js:L130–L195` (process.env)
  - `backend/routes/nofo.js:L31–L34` (process.env)
  - `backend/routes/profiles.js:L423–L427` (process.env)
  - `backend/services/anyaOrchestrator.js:L49` (process.env)
  - `backend/services/diagnosticsService.js:L395` (process.env)
  - `backend/services/documentIngestion.js:L73–L800` (process.env)
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L119` (process.env)
  - `backend/services/hamilton/portalSync/llmPageExtract.js:L83` (process.env)
  - `backend/services/john/johnEmailComposerAI.js:L51–L57` (process.env)
  - `backend/services/laptopConnector/laptopAnalyzer.js:L29` (process.env)
  - `backend/services/pipelineAutomation.js:L87` (process.env)
  - `backend/tests/johnOrgResearch.test.js:L92` (process.env)
  - `backend/tests/portalLlmExtract.test.js:L47–L87` (process.env)
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
  - `backend/routes/admin.js:L746` (process.env)
  - `backend/routes/ai.js:L148–L531` (process.env)
  - `backend/routes/nofo.js:L272` (process.env)
  - `backend/routes/profiles.js:L3252–L3424` (process.env)
  - `backend/services/anyaOrchestrator.js:L74–L1490` (process.env)
  - `backend/services/documentIngestion.js:L854` (process.env)
  - `backend/services/fundingTraceService.js:L214` (process.env)
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L130` (process.env)
  - `backend/services/john/johnEmailComposerAI.js:L44` (process.env)
  - `backend/services/laptopConnector/laptopAnalyzer.js:L40` (process.env)
  - `backend/services/pipelineAutomation.js:L492` (process.env)
  - `backend/utils/aiProviders.js:L113–L188` (process.env)

### `ANTHROPIC_MODEL_SCHOOL_LOOKUP`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/ai.js:L1732` (process.env)

### `ANTHROPIC_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/aiProviders.js:L24` (process.env)

### `ANYA_ADMIN_GEO_COOLDOWN_HOURS`

- **Templates**:
  - `backend/env.example:141` = `24`
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L31` (process.env)

### `ANYA_ADMIN_GEO_ON_LOGIN`

- **Templates**:
  - `backend/env.example:139` = `true`
- **Code references**: (none)

### `ANYA_ADMIN_GEO_OVERPASS_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L110` (process.env)

### `ANYA_ADMIN_GEO_OVERPASS_RADIUS_KM`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L109` (process.env)

### `ANYA_ADMIN_GEO_SKIP_DOMAIN_CORPUS`

- **Templates**:
  - `backend/env.example:145` = `true`
- **Code references**: (none)

### `ANYA_ADMIN_GEO_STATE_PACING_MS`

- **Templates**:
  - `backend/env.example:143` = `2000`
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L106` (process.env)

### `ANYA_ADMIN_TOKEN`

- **Templates**:
  - `backend/env.example:45` = `anya-dev-token`
- **Code references**:
  - `backend/routes/anya.js:L25` (process.env)
  - `backend/routes/authMe.js:L286` (process.env)
  - `backend/routes/blocklist.js:L35` (process.env)
  - `backend/routes/emailGrants.js:L31` (process.env)
  - `backend/routes/john.js:L69` (process.env)
  - `backend/routes/robert.js:L62` (process.env)
  - `backend/routes/sam.js:L159` (process.env)
  - `backend/routes/vehicles.js:L38` (process.env)
  - `backend/server.js:L159–L1711` (process.env)
  - `backend/services/anyaAdminTools.js:L1350` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L214` (process.env)
  - `backend/services/anyaStartupAudit.js:L43` (process.env)
  - `backend/services/anyaToolRegistry.js:L3916–L4089` (process.env)
  - `backend/services/codeGuardService.js:L83` (process.env)
  - `backend/services/diagnosticsService.js:L400` (process.env)
  - `backend/services/sam/samHttpProbe.js:L54` (process.env)
  - `backend/tests/testServer.js:L19` (process.env)
  - `scripts/_lib/secrets.mjs:L22` (process.env)
  - `scripts/dedupe-profiles.mjs:L29` (process.env)
  - `scripts/verify-prod-issues.mjs:L12` (process.env)

### `ANYA_ANTHROPIC_COOLDOWN_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L44` (process.env)

### `ANYA_ANTHROPIC_FAILURE_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L43` (process.env)

### `ANYA_ANTHROPIC_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L583` (process.env)
  - `backend/routes/ai.js:L63` (process.env)
  - `backend/routes/anya.js:L153` (process.env)
  - `backend/routes/nofo.js:L36` (process.env)
  - `backend/routes/profiles.js:L429` (process.env)
  - `backend/services/anyaOrchestrator.js:L55` (process.env)
  - `backend/services/documentIngestion.js:L80` (process.env)
  - `backend/services/pipelineAutomation.js:L93` (process.env)
  - `backend/utils/aiProviders.js:L25` (process.env)

### `ANYA_ANTHROPIC_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L582` (process.env)
  - `backend/routes/ai.js:L62` (process.env)
  - `backend/routes/anya.js:L152` (process.env)
  - `backend/routes/nofo.js:L35` (process.env)
  - `backend/routes/profiles.js:L428` (process.env)
  - `backend/services/anyaOrchestrator.js:L54` (process.env)
  - `backend/services/documentIngestion.js:L79` (process.env)
  - `backend/services/pipelineAutomation.js:L92` (process.env)
  - `backend/utils/aiProviders.js:L24` (process.env)

### `ANYA_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/middleware/authIdentity.js:L54` (process.env)
  - `backend/server.js:L1500–L1533` (process.env)
  - `tests/unit/authIdentity.test.mjs:L119–L375` (process.env)

### `ANYA_AUTONOMOUS_ENABLED`

- **Templates**:
  - `backend/env.example:125` = `false`
- **Code references**:
  - `backend/server.js:L3064` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L32` (process.env)
  - `backend/services/anyaBootstrap.js:L76` (process.env)
  - `backend/tests/testServer.js:L22` (process.env)
  - `scripts/check-anya-status.mjs:L23–L107` (process.env)

### `ANYA_CODE_CRAWL`

- **Templates**:
  - `backend/env.example:148` = `true              # Scan and fix code issues`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L45` (process.env)

### `ANYA_CRAWLERS`

- **Templates**:
  - `backend/env.example:150` = `true                # Run grant crawlers`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L47` (process.env)

### `ANYA_DRY_RUN`

- **Templates**:
  - `backend/env.example:166` = `false                # Dry run mode (no actual changes)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L63–L75` (process.env)

### `ANYA_FIX_CONSOLE`

- **Templates**:
  - `backend/env.example:153` = `true             # Fix console.log statements`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L60` (process.env)

### `ANYA_FIX_EMPTY_CATCH`

- **Templates**:
  - `backend/env.example:154` = `true         # Fix empty catch blocks`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L61` (process.env)

### `ANYA_FIX_ERRORS`

- **Templates**:
  - `backend/env.example:165` = `false             # Auto-fix found errors`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L74` (process.env)

### `ANYA_FUNCTION_TESTS`

- **Templates**:
  - `backend/env.example:149` = `true          # Test API endpoints`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L46` (process.env)

### `ANYA_FUNCTION_TEST_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousFunctionTesting.js:L315` (process.env)

### `ANYA_GEO_CRAWL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L50` (process.env)

### `ANYA_HEALTH_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaHealthService.js:L353` (process.env)
  - `tests/unit/health-service-singleton.test.mjs:L14` (process.env)

### `ANYA_ITEM_DISCOVERY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L48` (process.env)

### `ANYA_ITEM_DISCOVERY_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L79` (process.env)

### `ANYA_ITEM_DISCOVERY_MIN_COUNT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L78` (process.env)

### `ANYA_MATCH_SCOUT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L51` (process.env)

### `ANYA_MATCH_SCOUT_CANDIDATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaMatchScout.js:L56` (process.env)

### `ANYA_MATCH_SCOUT_MAX_ALERTS_PER_PROFILE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaMatchScout.js:L50` (process.env)

### `ANYA_MATCH_SCOUT_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaMatchScout.js:L44` (process.env)

### `ANYA_MATCH_THRESHOLD`

- **Templates**:
  - `backend/env.example:160` = `80           # Min % match to save to profile (0-100)`
- **Code references**: (none)

### `ANYA_MAX_FILE_CHANGES`

- **Templates**:
  - `backend/env.example:155` = `20          # Max files to modify per run`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L62` (process.env)

### `ANYA_OPENAI_COOLDOWN_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L30` (process.env)

### `ANYA_OPENAI_FAILURE_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L29` (process.env)

### `ANYA_OPENAI_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L78` (process.env)

### `ANYA_OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L73` (process.env)
  - `backend/services/anyaToolRegistry.js:L1010–L3440` (process.env)
  - `backend/utils/aiProviders.js:L96–L156` (process.env)

### `ANYA_OPENAI_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L73` (process.env)

### `ANYA_PORTAL_CHECKS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L49` (process.env)

### `ANYA_RUN_ON_ADMIN_LOGIN`

- **Templates**:
  - `backend/env.example:129` = `false    # Run when admin logs in`
- **Code references**:
  - `backend/routes/auth.js:L2082` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L36` (process.env)

### `ANYA_RUN_ON_SCHEDULE`

- **Templates**:
  - `backend/env.example:130` = `false       # Run on schedule (cron)`
- **Code references**:
  - `backend/server.js:L3086` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L37` (process.env)
  - `backend/services/anyaBootstrap.js:L103` (process.env)
  - `backend/startup/backgroundServices.js:L247` (process.env)

### `ANYA_RUN_ON_STARTUP`

- **Templates**:
  - `backend/env.example:128` = `false        # Run when server starts`
- **Code references**:
  - `backend/server.js:L3066` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L35` (process.env)
  - `backend/services/anyaBootstrap.js:L61` (process.env)
  - `backend/startup/backgroundServices.js:L235` (process.env)
  - `scripts/check-anya-status.mjs:L24` (process.env)

### `ANYA_SAVE_GLOBAL`

- **Templates**:
  - `backend/env.example:161` = `true             # Save all opportunities globally`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L70` (process.env)

### `ANYA_SCHEDULE`

- **Templates**:
  - `backend/env.example:131` = `0 3 * * *           # Cron schedule (default: 3 AM daily)`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L55` (process.env)

### `ANYA_SELF_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/anya.js:L33` (process.env)
  - `backend/routes/anyaMatchSuggestions.js:L102` (process.env)
  - `backend/routes/laptopConnector.js:L398` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L196` (process.env)

### `ANYA_USAGE_RETENTION_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/jobs/anyaBrainCleanup.js:L28` (process.env)

### `ANYA_WAIT_COMPLETION`

- **Templates**:
  - `backend/env.example:162` = `false        # Wait for crawlers to complete`
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L71` (process.env)

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
  - `backend/services/diagnosticsService.js:L393` (process.env)

### `API_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/diagnose-anya.mjs:L22` (process.env)

### `APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/profiles.js:L3809` (process.env)

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
  - `backend/routes/auth.js:L158` (process.env)

### `AUTH_ACCESS_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:61` = `10800`
- **Code references**:
  - `backend/routes/auth.js:L130` (process.env)

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
  - `backend/routes/auth.js:L132` (process.env)

### `AUTH_EMAIL_FROM`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/onboardingRoute.test.js:L183` (process.env)

### `AUTH_EMAIL_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L202` (process.env)

### `AUTH_EMAIL_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:64` = `45`
- **Code references**:
  - `backend/routes/auth.js:L133` (process.env)

### `AUTH_EMAIL_SEND_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L1771–L2773` (process.env)
  - `backend/routes/onboarding.js:L547` (process.env)
  - `backend/tests/onboardingRoute.test.js:L179` (process.env)

### `AUTH_FACEBOOK_CLIENT_ID`

- **Templates**:
  - `backend/env.example:171` = `facebook-client-id`
- **Code references**: (none)

### `AUTH_FACEBOOK_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:172` = `facebook-client-secret`
- **Code references**: (none)

### `AUTH_FRONTEND_APP_BASE`

- **Templates**:
  - `backend/env.example:71` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L158` (process.env)
  - `backend/server.js:L210–L660` (process.env)

### `AUTH_FRONTEND_URL`

- **Templates**:
  - `backend/env.example:70` = `http://localhost:5173`
- **Code references**:
  - `backend/routes/auth.js:L156` (process.env)
  - `backend/services/diagnosticsService.js:L404` (process.env)

### `AUTH_GOOGLE_CLIENT_ID`

- **Templates**:
  - `backend/env.example:169` = `google-client-id`
- **Code references**: (none)

### `AUTH_GOOGLE_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:170` = `google-client-secret`
- **Code references**: (none)

### `AUTH_JWT_SECRET`

- **Templates**:
  - `backend/env.example:60` = `dev-secret-change-me`
- **Code references**:
  - `backend/routes/authMe.js:L283` (process.env)
  - `backend/routes/health.js:L74` (process.env)
  - `backend/server.js:L1436–L1708` (process.env)
  - `backend/utils/runtimeSecrets.js:L31` (process.env)
  - `scripts/verify-stability.mjs:L17` (process.env)
  - `tests/unit/hamilton-auth-backup-plan.test.mjs:L27–L28` (process.env)
  - `tests/unit/hamilton-credential-csv-import.test.mjs:L38–L39` (process.env)
  - `tests/unit/hamilton-credential-vault-management.test.mjs:L32–L33` (process.env)
  - `tests/unit/hamilton-document-resume.test.mjs:L20–L21` (process.env)
  - `tests/unit/hamilton-inline-field-fix.test.mjs:L27–L27` (process.env)
  - `tests/unit/hamilton-missing-info-alert.test.mjs:L18–L19` (process.env)
  - `tests/unit/hamilton-missing-info-resume.test.mjs:L22–L23` (process.env)
  - `tests/unit/hamilton-parse-reconcile.test.mjs:L20–L21` (process.env)
  - `tests/unit/hamilton-portal-credential-vault.test.mjs:L40–L41` (process.env)

### `AUTH_NOTIFY_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/diagnosticsService.js:L399` (process.env)
  - `backend/services/email.js:L250` (process.env)

### `AUTH_NOTIFY_ON_LOGIN`

- **Templates**:
  - `backend/env.example:101` = `true`
- **Code references**:
  - `backend/services/diagnosticsService.js:L398` (process.env)
  - `backend/services/email.js:L249` (process.env)

### `AUTH_OAUTH_STATE_TTL`

- **Templates**:
  - `backend/env.example:67` = `600`
- **Code references**:
  - `backend/routes/auth.js:L136` (process.env)

### `AUTH_PASSWORD_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L216` (process.env)

### `AUTH_PASSWORD_SETUP_TTL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L137` (process.env)

### `AUTH_PHONE_CODE_TTL`

- **Templates**:
  - `backend/env.example:65` = `600`
- **Code references**:
  - `backend/routes/auth.js:L134` (process.env)

### `AUTH_PHONE_RATE_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L209` (process.env)

### `AUTH_PHONE_RESEND_SECONDS`

- **Templates**:
  - `backend/env.example:66` = `60`
- **Code references**:
  - `backend/routes/auth.js:L135` (process.env)

### `AUTH_PUBLIC_URL`

- **Templates**:
  - `backend/env.example:69` = `http://localhost:5173/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L155` (process.env)
  - `backend/routes/stripe.js:L23` (process.env)
  - `backend/services/diagnosticsService.js:L403` (process.env)

### `AUTH_REFRESH_TOKEN_TTL`

- **Templates**:
  - `backend/env.example:62` = `2592000`
- **Code references**:
  - `backend/routes/auth.js:L131` (process.env)

### `AUTH_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/check-crawler-results.mjs:L25` (process.env)
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L27` (process.env)

### `AUTH_YAHOO_CLIENT_ID`

- **Templates**:
  - `backend/env.example:173` = `yahoo-client-id`
- **Code references**: (none)

### `AUTH_YAHOO_CLIENT_SECRET`

- **Templates**:
  - `backend/env.example:174` = `yahoo-client-secret`
- **Code references**: (none)

### `AUTO_DISCOVERY_DAILY_ENABLED`

- **Templates**:
  - `backend/env.example:135` = `false`
- **Code references**:
  - `backend/server.js:L3119` (process.env)
  - `backend/services/anyaBootstrap.js:L123` (process.env)
  - `backend/services/scheduledAutoDiscovery.js:L23` (process.env)
  - `backend/startup/backgroundServices.js:L265` (process.env)

### `AUTO_DISCOVERY_DAILY_HOUR`

- **Templates**:
  - `backend/env.example:136` = `3       # Local server hour to run (default: 3 AM)`
- **Code references**:
  - `backend/services/scheduledAutoDiscovery.js:L24` (process.env)

### `AUTO_POPULATE_PER_SECTION_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/apply/applyEngine.js:L1142` (process.env)

### `AUTO_POPULATE_TOTAL_BUDGET_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/apply/applyEngine.js:L1145` (process.env)

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
  - `backend/services/anyaAdminTools.js:L1315` (process.env)
  - `scripts/runtime-crawl-local.mjs:L79` (process.env)

### `BASELINE_SEED_MODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1187` (process.env)
  - `backend/startup/selfHeal.js:L96` (process.env)
  - `backend/tests/selfHealObservability.test.js:L34–L39` (process.env)

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

### `BEHAVIOR_LEARNING_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/behaviorLearning.js:L63` (process.env)
  - `backend/tests/behaviorLearning.test.js:L66` (process.env)

### `BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/billing/invoiceService.js:L231` (process.env)

### `BILLING_AUTOMATION_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/billing/invoiceService.js:L30` (process.env)

### `BILLING_CYCLE_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3210` (process.env)

### `BILLING_OWNER_CC`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/billing/accountStatus.js:L25` (process.env)
  - `backend/services/billing/invoiceService.js:L33` (process.env)

### `BILLING_SECOND_NOTICE_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/billing/invoiceService.js:L35` (process.env)

### `BILLING_SUSPEND_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/billing/invoiceService.js:L36–L243` (process.env)

### `BLOCKLIST_INGEST_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/blocklist.js:L38` (process.env)

### `BRAVE_SEARCH_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2671` (process.env)
  - `backend/services/shared/webSearchEngine.js:L67` (process.env)
  - `backend/services/yana/webSearchProvider.js:L51` (process.env)
  - `backend/tests/webSearchEngine.test.js:L50–L130` (process.env)

### `BROADCAST_FROM_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/comms/commsService.js:L36–L41` (process.env)

### `BUILD_TIME`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/version.js:L39` (process.env)

### `BUILD_TIMESTAMP`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2382` (process.env)

### `BULK_POPULATE_KEY`

- **Templates**:
  - `backend/env.example:36` = ``
- **Code references**:
  - `backend/middleware/authIdentity.js:L53` (process.env)
  - `backend/routes/authMe.js:L287` (process.env)
  - `backend/routes/crawlerV2.js:L8` (process.env)
  - `backend/routes/crawlers.js:L1685–L2444` (process.env)
  - `backend/server.js:L1478–L1712` (process.env)
  - `tests/unit/authIdentity.test.mjs:L93–L162` (process.env)

### `CI`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/detector/engines/browser/detect-url.mjs:L148–L251` (process.env)
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
  - `backend/routes/health.js:L45–L359` (process.env)
  - `backend/server.js:L2106` (process.env)
  - `backend/startup/backgroundServices.js:L417` (process.env)

### `COMPREHENSIVE_GEO_JOB_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L83` (process.env)
  - `backend/services/dataReadinessService.js:L156` (process.env)

### `COMPREHENSIVE_JOB_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L73` (process.env)

### `COMPUTERNAME`

- **Templates**: (not present)
- **Code references**:
  - `tools/laptop-connector/scan.js:L122` (process.env)

### `CONFIRM`

- **Templates**: (not present)
- **Code references**:
  - `scripts/godaddy-set-vercel-dns.mjs:L157` (process.env)

### `CONNECTOR_INGEST_MAX_TERMS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/connectorIngestService.js:L476` (process.env)

### `CORE_TIMEOUT_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L187` (process.env)

### `CORS_ORIGIN`

- **Templates**:
  - `backend/env.example:44` = `http://localhost:5173,http://127.0.0.1:5173,https://app.axiombiolabs.org,https://www.axiombiolabs.org`
- **Code references**:
  - `backend/services/deadlineEmailSmsService.js:L70` (process.env)
  - `scripts/doctor.mjs:L80` (process.env)
  - `tests/helpers/backendHarness.mjs:L83` (process.env)
  - `tests/unit/anya-tasks.test.mjs:L57` (process.env)
  - `tests/unit/api-contracts.test.mjs:L78` (process.env)

### `COUNTRIES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-geocrawl-all-zips.mjs:L26–L27` (process.env)

### `COUNTY_FUNDING_CRAWLER_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L31` (process.env)
  - `tests/unit/county-crawler-honest-directory.test.mjs:L7–L35` (process.env)

### `CRAWLER_COVERAGE_FAILURE_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samRegistry.js:L980` (process.env)

### `CRAWLER_DATA_DIR`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/populate-geo-coverage.mjs:L62–L63` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L20–L22` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L24–L25` (process.env)
  - `backend/scripts/run-geo-profile-zips.mjs:L13–L14` (process.env)
  - `backend/services/comprehensiveCrawlerOptimized.js:L45–L599` (process.env)
  - `backend/services/crawlerDispatcher.js:L31–L32` (process.env)
  - `backend/tests/testServer.js:L21` (process.env)
  - `tests/e2e/playwright.config.mjs:L11` (process.env)

### `CRAWLER_DISPATCH_BASE_DELAY_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L209` (process.env)

### `CRAWLER_DISPATCH_MAX_ATTEMPTS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L205` (process.env)

### `CRAWLER_DISPATCH_MAX_DELAY_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L210` (process.env)

### `CRAWLER_FLOOR`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L17` (process.env)

### `CRAWLER_JOB_STUCK_THRESHOLD_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/dataReadinessService.js:L159` (process.env)

### `CRAWLER_JOB_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L60` (process.env)
  - `tests/unit/geo-crawl-state-summary.test.mjs:L134` (process.env)
  - `tests/unit/local-crawler-job.test.mjs:L90` (process.env)

### `CRAWLER_MAX_CONCURRENCY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L200` (process.env)

### `CRAWLER_MAX_RETRY_DELAY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/jobBackpressure.js:L25` (process.env)

### `CRAWLER_MAX_SOURCES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-doctor.mjs:L143` (process.env)

### `CRAWLER_MIN_FLOOR`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L17` (process.env)

### `CRAWLER_OS_ALLOW_LEGACY`

- **Templates**: (not present)
- **Code references**:
  - `scripts/check-runtime-imports.mjs:L225` (process.env)

### `CRAWLER_PROFILE_ID`

- **Templates**: (not present)
- **Code references**:
  - `scripts/crawler-run.mjs:L15` (process.env)

### `CRAWLER_RETRY_BASE_DELAY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/jobBackpressure.js:L20` (process.env)

### `CRAWLER_STALE_CLEANUP_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L37` (process.env)

### `CRAWLER_STALE_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/crawlerV2.js:L38` (process.env)

### `CRAWLER_STALE_HEARTBEAT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L45` (process.env)

### `CRAWLER_STALE_RUNNING_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L36` (process.env)

### `CRAWL_FALLBACK_RESERVE_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/realCrawlers.js:L83` (process.env)

### `CRAWL_TIME_BUDGET_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/realCrawlers.js:L76` (process.env)

### `CRAWL_TOTAL_BUDGET_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/realCrawlers.js:L75` (process.env)

### `CURSOR_PROJECT_DIR`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/hook-lib.mjs:L1092–L1093` (process.env)

### `DATABASE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/audit-section-metadata.mjs:L62` (process.env)
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
  - `scripts/crawler-doctor.mjs:L19` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L24` (process.env)
  - `scripts/seed-matched-grants.mjs:L37` (process.env)
  - `scripts/seed-profile-grants.mjs:L22` (process.env)
  - `tools/weekly-link-verify.mjs:L27` (process.env)

### `DB_AUTO_MIGRATE`

- **Templates**:
  - `backend/env.example:22` = `false`
- **Code references**:
  - `backend/start.js:L27–L36` (process.env)
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
  - `backend/services/diagnosticsService.js:L120–L402` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L41` (process.env)
  - `scripts/check-profiles.mjs:L45–L46` (process.env)
  - `scripts/db-opportunity-tag-stats.cjs:L3` (process.env)
  - `scripts/db-term-coverage.cjs:L3` (process.env)
  - `scripts/db-top-tags.cjs:L3` (process.env)
  - `scripts/db-url-stats.cjs:L3` (process.env)
  - `scripts/ensure-admin-user.mjs:L24` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L21` (process.env)
  - `scripts/reattach-users-simple.mjs:L10–L11` (process.env)
  - `scripts/run-geocrawl-all-zips.mjs:L24` (process.env)
  - `scripts/seed-profiles.mjs:L44–L45` (process.env)

### `DB_POOL_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L587` (process.env)

### `DB_PROVIDER`

- **Templates**:
  - `.env.example:192` = `sqlite`
  - `backend/env.example:9` = `sqlite`
- **Code references**:
  - `backend/db/index.js:L72` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L164` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L5` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L8` (process.env)

### `DEDUPE_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L16` (process.env)
  - `scripts/dedupe-profiles.mjs:L28` (process.env)

### `DEPLOY_ENV`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousCrawler.js:L609` (process.env)
  - `backend/services/anyaAutonomousFunctionRunner.js:L30` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L53` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L19` (process.env)
  - `backend/services/anyaTestRepair.js:L14` (process.env)
  - `backend/services/nationalPrograms/audit.js:L12` (process.env)
  - `tests/unit/security-hardening.test.mjs:L43–L68` (process.env)

### `DEPLOY_TIMESTAMP`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L361` (process.env)

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

### `DISABLE_BACKGROUND_SERVICES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1283` (process.env)

### `DISABLE_SEEDING`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/seed-profile-grants.mjs:L22` (process.env)
  - `backend/utils/seedOnStartup.js:L28` (process.env)
  - `scripts/prepopulate-profile-grants.mjs:L31` (process.env)
  - `scripts/seed-matched-grants.mjs:L31` (process.env)
  - `scripts/seed-profile-grants.mjs:L16` (process.env)
  - `tests/unit/matchDecisionEngine.lifecycle.test.mjs:L468–L479` (process.env)
  - `tests/unit/strict-matching-discovery.test.mjs:L327–L336` (process.env)

### `DISCOVER_ALL_THROTTLE_MIN`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/realCrawlers.js:L635` (process.env)

### `DOMAIN_CORPUS_CRAWL_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlers/domainCorpusCrawler.js:L19` (process.env)

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

### `ECF_LIVE_FETCH_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlers/ecfBenefitsCrawler.js:L31` (process.env)

### `ECF_LIVE_FETCH_USER_AGENT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlers/ecfBenefitsCrawler.js:L33` (process.env)

### `EMAIL_FROM`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L2555–L2733` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L26` (process.env)
  - `backend/services/email.js:L21–L34` (process.env)

### `EMAIL_GRANTS_INGEST_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/emailGrants.js:L34` (process.env)

### `EMAIL_GRANTS_SYNC_CRON`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/emailGrants/emailGrantScheduler.js:L35` (process.env)

### `EMAIL_GRANTS_SYNC_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/emailGrants/emailGrantScheduler.js:L32` (process.env)
  - `backend/services/robert/robertEmailFeedBridge.js:L32` (process.env)
  - `backend/tests/robertCatalogMiner.test.js:L327–L336` (process.env)

### `EMAIL_GRANTS_SYNC_TOP`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/emailGrants/emailGrantScheduler.js:L41` (process.env)
  - `backend/services/robert/robertEmailFeedBridge.js:L36` (process.env)

### `EMAIL_GRANTS_SYNC_TZ`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/emailGrants/emailGrantScheduler.js:L38` (process.env)

### `ENABLE_ASSISTANCE_DIRECTORIES_SEED`

- **Templates**:
  - `backend/env.example:28` = `false`
- **Code references**: (none)

### `ENABLE_CENSUS_GEO`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/censusGeo.test.js:L40–L106` (process.env)
  - `vitest.setup.js:L12–L12` (process.env)

### `ENABLE_MIN_NATIONAL_ENSURE`

- **Templates**:
  - `backend/env.example:27` = `false`
- **Code references**:
  - `backend/server.js:L1296` (process.env)
  - `backend/startup/selfHeal.js:L265` (process.env)

### `ENABLE_REGISTRY_VERIFICATION`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/nonprofitRegistry.test.js:L44–L132` (process.env)
  - `vitest.setup.js:L11–L11` (process.env)

### `ENFORCE_PROFILE_SCOPED_PIPELINE`

- **Templates**: (not present)
- **Code references**:
  - `backend/startup/enforceInvariants.js:L680–L694` (process.env)
  - `backend/tests/enforceInvariants.test.js:L470–L506` (process.env)

### `ENFORCE_RELEVANCE_FLOOR`

- **Templates**: (not present)
- **Code references**:
  - `backend/startup/enforceInvariants.js:L597` (process.env)
  - `backend/tests/enforceInvariants.test.js:L355–L715` (process.env)
  - `backend/tests/studentAidRecall.test.js:L229` (process.env)

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
  - `backend/routes/auth.js:L2555–L2733` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L26` (process.env)
  - `backend/services/diagnosticsService.js:L397` (process.env)
  - `backend/services/email.js:L21–L34` (process.env)

### `FRONTEND_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L156` (process.env)
  - `backend/services/diagnosticsService.js:L404` (process.env)

### `FRONTEND_COMPONENTS_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAutonomousFunctionTesting.js:L41` (process.env)

### `FRONTEND_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/stripeService.js:L98` (process.env)

### `FUNDING_APIS_REQUIRE_KEYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/src/config/apiKeys.js:L80` (process.env)

### `FUNDING_TRACE_MAX_AGE_YEARS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/fundingTraceService.js:L38` (process.env)

### `FUNDING_TRACE_MIN_AMOUNT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/fundingTraceService.js:L37` (process.env)

### `GEO_BATCH_SIZE`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L390` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L28` (process.env)

### `GEO_COUNTIES_BY_STATE_PATH`

- **Templates**:
  - `backend/env.example:53` = ``
- **Code references**:
  - `backend/routes/admin.js:L88–L2177` (process.env)

### `GEO_CRAWL_FIXTURES_DIR`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/comprehensiveCrawlerOptimized.js:L343–L408` (process.env)
  - `backend/services/crawlers/nationalZipCrawler.js:L397` (process.env)

### `GEO_CRAWL_HEARTBEAT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlers/nationalZipCrawler.js:L1763` (process.env)

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

### `GEO_RESUME_WINDOW_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlers/nationalZipCrawler.js:L1521` (process.env)

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

### `GF_ADMIN_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L59` (process.env)
  - `scripts/admin-geocrawl-until-complete.mjs:L39` (process.env)

### `GF_ADMIN_PASSWORD`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L60` (process.env)
  - `scripts/admin-geocrawl-until-complete.mjs:L40` (process.env)

### `GF_API`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L16` (process.env)
  - `scripts/admin-geocrawl-until-complete.mjs:L38` (process.env)
  - `scripts/admin-pipeline-verify-flat.mjs:L13` (process.env)
  - `scripts/admin-process-all-pipelines.mjs:L28` (process.env)
  - `scripts/admin-purge-loan-grants.mjs:L27` (process.env)
  - `scripts/admin-run-student-bridge-funding.mjs:L19` (process.env)
  - `scripts/anastasia-fix-cycle-and-add-july-bridge.mjs:L33` (process.env)
  - `scripts/anastasia-july-actionable-list.mjs:L7` (process.env)
  - `scripts/anastasia-mtsu-finish.mjs:L56` (process.env)

### `GF_COUNTRIES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-geocrawl-until-complete.mjs:L46` (process.env)

### `GF_DEDUPE_STRATEGIES`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L19` (process.env)

### `GF_GRANT_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-process-all-pipelines.mjs:L36` (process.env)

### `GF_MAX_WAIT_MS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-process-all-pipelines.mjs:L35` (process.env)

### `GF_POLL_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-process-all-pipelines.mjs:L34` (process.env)

### `GF_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L17` (process.env)
  - `scripts/admin-pipeline-verify-flat.mjs:L14` (process.env)
  - `scripts/admin-process-all-pipelines.mjs:L29` (process.env)
  - `scripts/admin-purge-loan-grants.mjs:L28` (process.env)
  - `scripts/admin-run-student-bridge-funding.mjs:L20` (process.env)
  - `scripts/anastasia-fix-cycle-and-add-july-bridge.mjs:L34` (process.env)
  - `scripts/anastasia-july-actionable-list.mjs:L8` (process.env)
  - `scripts/anastasia-mtsu-finish.mjs:L57` (process.env)

### `GITHUB_ACTIONS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/ensure-build-natives.mjs:L91` (process.env)

### `GITHUB_REPO`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/githubSyncVehicles.js:L84` (process.env)

### `GITHUB_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/githubSyncVehicles.js:L83` (process.env)

### `GIT_BRANCH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L360` (process.env)
  - `backend/routes/version.js:L35` (process.env)

### `GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L44–L359` (process.env)
  - `backend/routes/version.js:L33` (process.env)
  - `backend/server.js:L2105` (process.env)
  - `backend/startup/backgroundServices.js:L416` (process.env)

### `GMAIL_OAUTH_CLIENT_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/blocklist/gmailFilterSyncService.js:L20–L55` (process.env)

### `GMAIL_OAUTH_CLIENT_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/blocklist/gmailFilterSyncService.js:L21–L56` (process.env)

### `GMAIL_OAUTH_REFRESH_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/blocklist/gmailFilterSyncService.js:L22–L58` (process.env)

### `GOOGLE_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L84` (process.env)

### `GOOGLE_MAPS_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samRegistry.js:L152–L152` (process.env)

### `GOOGLE_SEARCH_CX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L85` (process.env)

### `GRANTFLOW_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/hamilton-import-chrome-csv.mjs:L32` (process.env)
  - `scripts/hamilton-route-chrome-csv.mjs:L48` (process.env)

### `GRANTFLOW_API`

- **Templates**: (not present)
- **Code references**:
  - `scripts/hamilton-import-chrome-csv.mjs:L31` (process.env)
  - `scripts/hamilton-route-chrome-csv.mjs:L47` (process.env)

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
  - `backend/server.js:L260` (process.env)
  - `backend/startup/bootstrap.js:L434` (process.env)

### `GRANTFLOW_SIGNIN_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/email.js:L122` (process.env)

### `GRANTFLOW_SKIP_VERIFICATION_GATE`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L258` (process.env)
  - `backend/startup/bootstrap.js:L432` (process.env)

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
  - `backend/services/diagnosticsService.js:L391` (process.env)
  - `backend/services/grantsDotGovCrawler.js:L21` (process.env)
  - `backend/services/realFundingCrawler.js:L28` (process.env)
  - `backend/services/shared/grantsGovApiClient.js:L20` (process.env)
  - `backend/services/shared/grantsGovClient.js:L38` (process.env)
  - `backend/src/integrations/grantsGov.js:L8` (process.env)

### `HAMILTON_ADMIN_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonAdminAccount.js:L31` (process.env)

### `HAMILTON_ADMIN_VAULT_PROFILE_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalCredentialService.js:L590` (process.env)
  - `backend/tests/hamiltonCredentialFallback.test.js:L17` (process.env)
  - `backend/tests/hamiltonPortalAutopilotIdentity.test.js:L20` (process.env)
  - `backend/tests/hamiltonPortalSignupAdapter.test.js:L18` (process.env)
  - `backend/tests/portalAutopilotCobrowseAndMerge.test.js:L20` (process.env)

### `HAMILTON_AUTOPILOT_MAX_PAGES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonAutopilotEngine.js:L51` (process.env)

### `HAMILTON_AUTOPILOT_NAV_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonAutopilotEngine.js:L49` (process.env)

### `HAMILTON_AUTOPILOT_STEP_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonAutopilotEngine.js:L50` (process.env)

### `HAMILTON_BATCH_SIZE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/anastasia-mtsu-finish.mjs:L206` (process.env)

### `HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/hamiltonBrowserAutomationGuard.test.js:L17–L51` (process.env)
  - `backend/tests/hamiltonPortalAutopilotIdentity.test.js:L24` (process.env)
  - `backend/tests/hamiltonPortalSignupAdapter.test.js:L44–L49` (process.env)
  - `backend/tests/portalAutopilotCobrowseAndMerge.test.js:L22` (process.env)
  - `backend/tests/portalSyncRequiresSession.test.js:L14` (process.env)

### `HAMILTON_BROWSER_STORAGE_DIR`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonCredentialSessionService.js:L131` (process.env)
  - `tests/unit/hamilton-hard-stop-alerts.test.mjs:L270` (process.env)
  - `tests/unit/hamilton-hard-stop-resolver.test.mjs:L146–L402` (process.env)

### `HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonCloudLogin.js:L74` (process.env)

### `HAMILTON_CLOUD_LOGIN_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonCloudLogin.js:L85` (process.env)

### `HAMILTON_CLOUD_LOGIN_PROVIDER`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonCloudLogin.js:L67` (process.env)

### `HAMILTON_ENABLE_BROWSER_AUTOMATION`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/hamiltonBrowserAutomationGuard.test.js:L16–L28` (process.env)
  - `backend/tests/hamiltonPortalAutopilotIdentity.test.js:L23` (process.env)
  - `backend/tests/hamiltonPortalSignupAdapter.test.js:L43–L48` (process.env)
  - `backend/tests/portalAutopilotCobrowseAndMerge.test.js:L21` (process.env)
  - `backend/tests/portalSyncRequiresSession.test.js:L13` (process.env)
  - `tests/unit/hamilton-automation.test.mjs:L359–L450` (process.env)

### `HAMILTON_PACKET_STORAGE_DIR`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:L488` (process.env)
  - `tests/unit/hamilton-automation.test.mjs:L127` (process.env)

### `HAMILTON_RUN_ON_SCHEDULE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonScheduler.js:L58–L134` (process.env)

### `HAMILTON_SCHEDULE_BATCH_SIZE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonScheduler.js:L68` (process.env)

### `HAMILTON_SCHEDULE_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonScheduler.js:L62` (process.env)

### `HAMILTON_SIGNUP_NAV_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalSignupAdapter.js:L60` (process.env)

### `HAMILTON_SIGNUP_STEP_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalSignupAdapter.js:L61` (process.env)

### `HAMILTON_SIGNUP_VERIFY_POLL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalSignupAdapter.js:L66` (process.env)

### `HAMILTON_SIGNUP_VERIFY_WAIT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalSignupAdapter.js:L65` (process.env)

### `HAMILTON_SUGGEST_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L125` (process.env)

### `HAMILTON_SUGGEST_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L130` (process.env)

### `HAMILTON_SUGGEST_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L124` (process.env)

### `HAMILTON_VAULT_UNLOCK_TTL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalMasterVault.js:L90` (process.env)

### `HAMILTON_WEEKLY_DIGEST_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/hamiltonWeeklyDigest.js:L36` (process.env)

### `HAMILTON_WEEKLY_DIGEST_HOUR_ET`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3344` (process.env)

### `HOME`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/hook-lib.mjs:L1238` (process.env)

### `HOSTNAME`

- **Templates**: (not present)
- **Code references**:
  - `tools/laptop-connector/scan.js:L122` (process.env)

### `HOURS_LOOKBACK`

- **Templates**: (not present)
- **Code references**:
  - `scripts/test-auto-merge-workflow.mjs:L10` (process.env)

### `IMPECCABLE_CONTEXT_DIR`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/context.mjs:L197` (process.env)

### `IMPECCABLE_CRITIQUE_META`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/critique-storage.mjs:L200` (process.env)

### `IMPECCABLE_HOOK_DEBUG`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/hook-before-edit.mjs:L472` (process.env)
  - `.cursor/skills/impeccable/scripts/hook.mjs:L57` (process.env)

### `IMPECCABLE_HOOK_DEPTH`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/hook.mjs:L30–L30` (process.env)

### `IMPECCABLE_HOOK_DISABLED`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/hook-admin.mjs:L276` (process.env)
  - `.cursor/skills/impeccable/scripts/hook-before-edit.mjs:L366` (process.env)

### `IMPECCABLE_LIVE_APPLY_EVENT_HARD_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/live/manual-apply.mjs:L7` (process.env)

### `IMPECCABLE_LIVE_APPLY_EVENT_SOFT_DEADLINE_MS`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/live/manual-apply.mjs:L8` (process.env)

### `IMPECCABLE_LIVE_COPY_AGENT_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/live-commit-manual-edits.mjs:L1227` (process.env)

### `IMPECCABLE_LIVE_DEBUG_EVENTS`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/live-server.mjs:L112` (process.env)

### `IMPECCABLE_LIVE_SVELTE_COMPONENT`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/live/svelte-component.mjs:L21` (process.env)

### `IMPECCABLE_NO_UPDATE_CHECK`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/context.mjs:L804` (process.env)

### `IMPECCABLE_PALETTE_SEED`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/palette.mjs:L472` (process.env)

### `IMPECCABLE_UPDATE_CACHE`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/context.mjs:L52` (process.env)

### `IMPECCABLE_UPDATE_HOST`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/context.mjs:L50` (process.env)

### `INGEST_CONNECTORS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/comprehensiveCrawlerOptimized.js:L605` (process.env)

### `INTERNAL_API_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/anyaAdminTools.js:L1313` (process.env)

### `INTERNAL_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samDiagnostics.js:L213` (process.env)

### `ITEM_SUGGESTIONS_PER_PROFILE`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L153` (process.env)

### `JOHN_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/blocklist.js:L35` (process.env)
  - `backend/routes/emailGrants.js:L31` (process.env)
  - `backend/routes/john.js:L70` (process.env)

### `JOHN_AI_DRAFTING`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/john/johnEmailComposerAI.js:L50` (process.env)

### `JOHN_AI_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/john/johnEmailComposerAI.js:L63` (process.env)

### `JOHN_AI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/john/johnEmailComposerAI.js:L43` (process.env)

### `JOHN_AI_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/john/johnEmailComposerAI.js:L62` (process.env)

### `JOHN_MAX_DRAFTS_PER_24H`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/agentTelemetry/agentTelemetryAggregator.js:L800` (process.env)

### `JOHN_PHYSICAL_ADDRESS`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/johnOrgResearch.test.js:L93` (process.env)

### `JOHN_WEB_RESEARCH`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/john/johnOrgResearch.js:L27` (process.env)
  - `backend/tests/johnOrgResearch.test.js:L94–L147` (process.env)

### `JWT_SECRET`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/authMe.js:L283` (process.env)
  - `backend/routes/health.js:L74` (process.env)
  - `backend/server.js:L1436–L1708` (process.env)
  - `backend/utils/runtimeSecrets.js:L32` (process.env)
  - `scripts/verify-stability.mjs:L17` (process.env)
  - `tests/unit/hamilton-auth-backup-plan.test.mjs:L27` (process.env)
  - `tests/unit/hamilton-credential-csv-import.test.mjs:L38` (process.env)
  - `tests/unit/hamilton-credential-vault-management.test.mjs:L32` (process.env)
  - `tests/unit/hamilton-document-resume.test.mjs:L20` (process.env)
  - `tests/unit/hamilton-missing-info-alert.test.mjs:L18` (process.env)
  - `tests/unit/hamilton-missing-info-resume.test.mjs:L22` (process.env)
  - `tests/unit/hamilton-parse-reconcile.test.mjs:L20` (process.env)
  - `tests/unit/hamilton-portal-credential-vault.test.mjs:L40` (process.env)

### `LAPTOP_CONNECTOR_API`

- **Templates**: (not present)
- **Code references**:
  - `tools/laptop-connector/capture.js:L145` (process.env)
  - `tools/laptop-connector/scan.js:L101` (process.env)

### `LAPTOP_CONNECTOR_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/laptopConnector/laptopAnalyzer.js:L35` (process.env)

### `LAPTOP_CONNECTOR_MAX_TEXT`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/laptopConnector/laptopAnalyzer.js:L169` (process.env)

### `LAPTOP_CONNECTOR_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/laptopConnector/laptopAnalyzer.js:L40` (process.env)

### `LAPTOP_CONNECTOR_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/laptopConnector/laptopAnalyzer.js:L34` (process.env)

### `LAPTOP_CONNECTOR_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `tools/laptop-connector/capture.js:L146` (process.env)
  - `tools/laptop-connector/scan.js:L102` (process.env)

### `LARRY_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L18–L184` (process.env)

### `LARRY_RUN_ON_SCHEDULE`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L33–L151` (process.env)

### `LARRY_RUN_ON_STARTUP`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L34–L185` (process.env)

### `LEGACY_GRANT_ONLY_EXCLUDES_MATCHING`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L264` (process.env)

### `LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/repair-profile-ownership.mjs:L168` (process.env)
  - `backend/scripts/restore-profile-sections-from-orgs.mjs:L16–L16` (process.env)
  - `scripts/db-top-tags.cjs:L5` (process.env)

### `LIMIT_OPPS_PER_PROFILE`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs:L29` (process.env)

### `LINK_VERIFICATION_BATCH`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3188–L3290` (process.env)

### `LINK_VERIFICATION_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3186` (process.env)

### `LOG_BUFFER_SIZE`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/logger.js:L51` (process.env)

### `LOG_LEVEL`

- **Templates**:
  - `backend/env.example:177` = `debug`
- **Code references**:
  - `backend/utils/logger.js:L25` (process.env)

### `MAINTENANCE_ESTIMATED_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/maintenance/maintenanceMode.js:L25` (process.env)

### `MAINTENANCE_GRACE_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/maintenance/maintenanceMode.js:L24` (process.env)

### `MAIN_DB_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verification/profiles-integrity.mjs:L15` (process.env)

### `MATCHING_ENGINE_FACET_DEBUG`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/matchEngine.js:L1349` (process.env)

### `MATCH_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs:L28` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L152` (process.env)

### `MAX_CONCURRENT_CRAWLERS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L17` (process.env)
  - `backend/services/crawlerDispatcher.js:L200` (process.env)

### `MAX_CRAWLER_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/jobBackpressure.js:L15` (process.env)

### `MAX_EXPORT_ROWS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L1101` (process.env)

### `MAX_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L408` (process.env)

### `MAX_ORPHAN_AUTO_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L23` (process.env)

### `MAX_ZIPS`

- **Templates**: (not present)
- **Code references**:
  - `scripts/run-geocrawl-all-zips.mjs:L25–L25` (process.env)

### `MIGRATE_ASSERT_FRESH`

- **Templates**: (not present)
- **Code references**:
  - `backend/start.js:L124–L124` (process.env)

### `MIGRATE_VERIFY_COUNTS`

- **Templates**: (not present)
- **Code references**:
  - `backend/start.js:L125–L125` (process.env)

### `MIN_NATIONAL_OPPORTUNITIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1292` (process.env)
  - `backend/startup/selfHeal.js:L259` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L139` (process.env)

### `MIN_NATIONAL_VISIBLE`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/opportunities.js:L585` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L86` (process.env)

### `MODE`

- **Templates**: (not present)
- **Code references**:
  - `src/utils/logger.js:L12` (import.meta.env)

### `MONDAY_PORTAL_REMINDER_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/hamilton/mondayPortalReminder.js:L48` (process.env)

### `MONDAY_PORTAL_REMINDER_HOUR_ET`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3395` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3550` (process.env)
  - `backend/services/sam/samRegistry.js:L503–L902` (process.env)
  - `backend/startup/backgroundServices.js:L369` (process.env)
  - `backend/tests/samDiscoveryAwareness.test.js:L52–L204` (process.env)
  - `backend/tests/testServer.js:L23` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3552` (process.env)
  - `backend/startup/backgroundServices.js:L371` (process.env)

### `NATIONAL_PROGRAMS_MAX_DEPTH`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3556` (process.env)
  - `backend/startup/backgroundServices.js:L379` (process.env)

### `NATIONAL_PROGRAMS_MAX_URLS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3555` (process.env)
  - `backend/startup/backgroundServices.js:L375` (process.env)

### `NIGHTLY_MAINTENANCE_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/maintenance/nightlySweep.js:L21` (process.env)

### `NIGHTLY_MAINTENANCE_HOUR_ET`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3441` (process.env)

### `NIGHTLY_MAINTENANCE_MINUTES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/maintenance/nightlySweep.js:L26` (process.env)

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
  - `backend/db/index.js:L11–L691` (process.env)
  - `backend/db/scopedQuery.js:L165` (process.env)
  - `backend/middleware/errorHandler.js:L13` (process.env)
  - `backend/routes/admin.js:L3611` (process.env)
  - `backend/routes/anya.js:L127–L202` (process.env)
  - `backend/routes/auth.js:L294–L2734` (process.env)
  - `backend/routes/grants.js:L2249–L2348` (process.env)
  - `backend/routes/health.js:L52–L236` (process.env)
  - `backend/routes/nofo.js:L319–L512` (process.env)
  - `backend/routes/onboarding.js:L185–L597` (process.env)
  - `backend/routes/reminders.js:L197–L222` (process.env)
  - `backend/routes/version.js:L36` (process.env)
  - `backend/scripts/seed-deterministic.mjs:L37` (process.env)
  - `backend/scripts/seed-profile-grants.mjs:L21` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L9` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L12` (process.env)
  - `backend/server.js:L227–L3542` (process.env)
  - `backend/services/anyaAutonomousCrawler.js:L608` (process.env)
  - `backend/services/anyaAutonomousFunctionRunner.js:L29` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L52` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L18` (process.env)
  - `backend/services/anyaTestRepair.js:L13–L232` (process.env)
  - `backend/services/avatarCrawler.js:L213` (process.env)
  - `backend/services/comprehensiveCrawlerOptimized.js:L580–L601` (process.env)
  - `backend/services/diagnosticsService.js:L44–L401` (process.env)
  - `backend/services/email.js:L22` (process.env)
  - `backend/services/hamilton/applicationTaskStore.js:L248` (process.env)
  - `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:L478` (process.env)
  - `backend/services/hamilton/hamiltonBlockerStore.js:L110` (process.env)
  - `backend/services/missionHealthService.js:L424` (process.env)
  - `backend/services/nationalPrograms/audit.js:L11` (process.env)
  - `backend/services/orgLogoFetcher.js:L293` (process.env)
  - `backend/services/packetPdf.js:L44–L68` (process.env)
  - `backend/src/config/apiKeys.js:L109` (process.env)
  - `backend/start.js:L28–L37` (process.env)
  - `backend/startup/backgroundServices.js:L221–L573` (process.env)
  - `backend/startup/bootstrap.js:L25–L433` (process.env)
  - `backend/startup/selfHeal.js:L264` (process.env)
  - `backend/tests/testServer.js:L11` (process.env)
  - `backend/utils/environment.js:L12–L25` (process.env)
  - `backend/utils/logger.js:L27` (process.env)
  - `backend/utils/runtimeSecrets.js:L45` (process.env)
  - `backend/utils/seedOnStartup.js:L26` (process.env)
  - `scripts/prepopulate-profile-grants.mjs:L30` (process.env)
  - `scripts/seed-matched-grants.mjs:L30` (process.env)
  - `scripts/seed-profile-grants.mjs:L15` (process.env)
  - `scripts/seed-profiles.mjs:L28` (process.env)
  - `src/components/organizations/PrintableProfile.jsx:L68` (process.env)
  - `tests/e2e/playwright.config.mjs:L32` (process.env)
  - `tests/smoke/playwright.config.mjs:L25` (process.env)
  - `tests/unit/avatar-website-cover.test.mjs:L11` (process.env)
  - `tests/unit/pipeline-source-allowlist.test.mjs:L107–L189` (process.env)
  - `tests/unit/security-hardening.test.mjs:L42–L66` (process.env)
  - `tests/unit/strict-matching-discovery.test.mjs:L312–L337` (process.env)

### `NOFO_FETCH_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/nofo.js:L75` (process.env)

### `NOFO_PARSE_MAX_TEXT_CHARS`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/nofo.js:L23` (process.env)

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

### `ONBOARDING_VERIFY_BASE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-onboarding-live.mjs:L16` (process.env)

### `OPENAI_API_KEY`

- **Templates**:
  - `backend/env.example:81` = `sk-your-openai-key`
- **Code references**:
  - `backend/routes/admin.js:L873–L1353` (process.env)
  - `backend/routes/anya.js:L200` (process.env)
  - `backend/scripts/create-profile-from-pdf.mjs:L75` (process.env)
  - `backend/scripts/dispatch-crawlers.mjs:L9` (process.env)
  - `backend/scripts/fix-anastasia-profile.mjs:L10` (process.env)
  - `backend/scripts/process-all-jobs.mjs:L9` (process.env)
  - `backend/scripts/process-anastasia-ai.mjs:L6` (process.env)
  - `backend/scripts/process-queue.mjs:L10` (process.env)
  - `backend/scripts/read-anastasia-vision.mjs:L5` (process.env)
  - `backend/services/diagnosticsService.js:L394` (process.env)
  - `backend/tests/profileSectionAiFallback.test.js:L10` (process.env)
  - `backend/utils/openaiClient.js:L29–L55` (process.env)

### `OPENAI_MAX_RETRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L78` (process.env)

### `OPENAI_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/apply/applyEngine.js:L1216` (process.env)
  - `backend/config/constants.js:L52` (process.env)
  - `backend/routes/admin.js:L55` (process.env)
  - `backend/routes/grants.js:L951` (process.env)
  - `backend/routes/legacyFunctions.js:L139` (process.env)
  - `backend/routes/nofo.js:L24` (process.env)
  - `backend/routes/profiles.js:L3212–L3401` (process.env)
  - `backend/services/anyaToolRegistry.js:L3440` (process.env)
  - `backend/services/grantApplicationApproachAdvisor.js:L232` (process.env)
  - `backend/services/medicalNecessity.js:L339` (process.env)
  - `backend/services/pipelineAutomation.js:L471` (process.env)
  - `backend/utils/aiProviders.js:L96–L156` (process.env)

### `OPENAI_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/utils/openaiClient.js:L73` (process.env)

### `OPPORTUNITY_INSERT_VERIFY_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/opportunityInserter.js:L503` (process.env)

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

### `OWNER_ALIAS_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/comms/commsService.js:L41` (process.env)

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
  - `backend/db/index.js:L40–L583` (process.env)

### `PGUSER`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L14–L37` (process.env)

### `PG_POOL_CONN_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L589` (process.env)

### `PG_POOL_IDLE_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L588` (process.env)

### `PG_POOL_MAX`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L587` (process.env)

### `PG_STATEMENT_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L590` (process.env)

### `PHASE5_JOB_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/profile-crawler-pipeline-isolation.test.mjs:L135` (process.env)

### `PHASE5_SERVER_READY_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/profile-crawler-pipeline-isolation.test.mjs:L49` (process.env)

### `PIPELINE_INSERT_RELEVANCE_FLOOR`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/relevanceFloor.js:L35` (process.env)

### `PIPELINE_JOB_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L66` (process.env)

### `PIPELINE_PURGE_RELEVANCE_FLOOR`

- **Templates**: (not present)
- **Code references**:
  - `backend/startup/enforceInvariants.js:L101` (process.env)

### `PIPELINE_RELEVANCE_FLOOR`

- **Templates**: (not present)
- **Code references**:
  - `backend/startup/enforceInvariants.js:L78–L133` (process.env)

### `PIPELINE_SLOW_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/middleware/pipelineMonitor.js:L13` (process.env)

### `PIPELINE_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2003` (process.env)

### `PIPELINE_TRUSTED_RELEVANCE_FLOOR`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/relevanceFloor.js:L60` (process.env)

### `PORT`

- **Templates**:
  - `.env.example:396` = `8080`
  - `backend/env.example:4` = `8080`
- **Code references**:
  - `backend/routes/sam.js:L143` (process.env)
  - `backend/server.js:L188–L2999` (process.env)
  - `backend/services/anyaAdminTools.js:L1315` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L208` (process.env)
  - `backend/services/anyaStartupAudit.js:L41` (process.env)
  - `backend/services/anyaToolRegistry.js:L3908–L4087` (process.env)
  - `backend/services/sam/samDiagnostics.js:L213` (process.env)
  - `backend/services/sam/samHttpProbe.js:L31` (process.env)
  - `backend/start.js:L26–L35` (process.env)
  - `backend/tests/testServer.js:L16` (process.env)
  - `scripts/runtime-crawl-local.mjs:L79` (process.env)
  - `tests/smoke/playwright.config.mjs:L24` (process.env)

### `PORTAL_SYNC_LLM_EXTRACT`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/portalLlmExtract.test.js:L48–L98` (process.env)

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

### `PRICING_AUTO_DISCOUNTS_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/pricing/chargeResolver.js:L51` (process.env)
  - `tests/unit/discount-engine.test.mjs:L17` (process.env)

### `PRICING_DISCOUNTS_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/discount-engine.test.mjs:L16–L126` (process.env)

### `PRICING_MAX_TOTAL_DISCOUNT_PERCENT`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/discount-engine.test.mjs:L19–L63` (process.env)

### `PRICING_REQUIRE_ADMIN_APPROVAL`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/admin-pricing-notifications.test.mjs:L5` (process.env)
  - `tests/unit/payment-gate-routing.test.mjs:L5` (process.env)
  - `tests/unit/profile-pricing-initializer.test.mjs:L9` (process.env)

### `PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/discount-engine.test.mjs:L18` (process.env)

### `PROBE_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `scripts/probe-deferred-rcs.mjs:L23` (process.env)

### `PROD`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L31` (import.meta.env)
  - `src/utils/enforceCanonicalHost.js:L4` (import.meta.env)

### `PROFILE_ID`

- **Templates**: (not present)
- **Code references**:
  - `scripts/anastasia-mtsu-finish.mjs:L58` (process.env)
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
  - `backend/services/profile/profileTaxonomy.js:L977` (process.env)

### `PUBLIC_APP_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/stripeService.js:L98` (process.env)

### `PUBLIC_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L155` (process.env)
  - `backend/routes/stripe.js:L24` (process.env)
  - `backend/services/diagnosticsService.js:L403` (process.env)

### `QUEUE_DRAIN_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L775` (process.env)

### `QUEUE_POLL_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2873` (process.env)
  - `backend/startup/queueRecovery.js:L140` (process.env)

### `QUEUE_POLL_INTERVAL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2872` (process.env)
  - `backend/startup/queueRecovery.js:L136` (process.env)

### `QUEUE_STAGGER_DELAY_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2878` (process.env)
  - `backend/startup/queueRecovery.js:L235` (process.env)

### `QUEUE_STARTUP_DELAY_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2877` (process.env)
  - `backend/startup/queueRecovery.js:L231` (process.env)

### `RAILWAY_DEPLOYMENT_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L105` (process.env)
  - `backend/routes/anya.js:L116` (process.env)

### `RAILWAY_DEPLOYMENT_START_TIME`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2383` (process.env)

### `RAILWAY_ENVIRONMENT`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L65–L102` (process.env)
  - `backend/routes/auth.js:L295–L2735` (process.env)
  - `backend/routes/health.js:L53` (process.env)
  - `backend/routes/version.js:L37–L38` (process.env)
  - `backend/server.js:L230` (process.env)
  - `backend/services/email.js:L23` (process.env)
  - `backend/startup/bootstrap.js:L29` (process.env)
  - `backend/utils/environment.js:L13–L23` (process.env)

### `RAILWAY_GIT_BRANCH`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L360` (process.env)
  - `backend/routes/version.js:L35` (process.env)

### `RAILWAY_GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L104` (process.env)
  - `backend/routes/health.js:L43–L359` (process.env)
  - `backend/routes/version.js:L33` (process.env)
  - `backend/server.js:L20–L2104` (process.env)
  - `backend/startup/backgroundServices.js:L415` (process.env)

### `RAILWAY_PROJECT_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L12–L100` (process.env)
  - `backend/server.js:L231` (process.env)
  - `backend/startup/bootstrap.js:L30` (process.env)

### `RAILWAY_SERVICE_ID`

- **Templates**: (not present)
- **Code references**:
  - `backend/db/index.js:L12–L101` (process.env)
  - `backend/server.js:L232` (process.env)
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
  - `backend/server.js:L451` (process.env)

### `RESEND_API_KEY`

- **Templates**:
  - `backend/env.example:95` = `re_your-resend-key`
- **Code references**:
  - `backend/routes/auth.js:L2554–L2732` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L20` (process.env)
  - `backend/services/diagnosticsService.js:L396` (process.env)
  - `backend/services/email.js:L20–L27` (process.env)

### `ROBERT_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/robert.js:L62` (process.env)

### `ROBERT_ALLOW_LIVE_WEB`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/robert-agent-silent-failure.test.mjs:L27–L42` (process.env)
  - `tests/unit/robert-agent.test.mjs:L12–L98` (process.env)

### `ROBERT_ALLOW_SOURCE_DISCOVERY`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/robert-agent-silent-failure.test.mjs:L28` (process.env)
  - `tests/unit/robert-agent.test.mjs:L13–L76` (process.env)

### `ROBERT_AUTO_INGEST_VERIFIED`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/robert-agent-silent-failure.test.mjs:L29–L43` (process.env)
  - `tests/unit/robert-agent.test.mjs:L14–L99` (process.env)

### `ROBERT_CONTACTS_MAILBOX`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/robert/robertContactDiscovery.js:L44` (process.env)

### `ROBERT_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/samDiscoveryAwareness.test.js:L228` (process.env)
  - `tests/unit/robert-agent-silent-failure.test.mjs:L26–L41` (process.env)
  - `tests/unit/robert-agent.test.mjs:L11–L97` (process.env)
  - `tests/unit/robert-safety.test.mjs:L17` (process.env)

### `ROBERT_JOHN_DEFAULT_LEAD_SCORE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/robert/robertJohnBridge.js:L63` (process.env)

### `ROBERT_JOHN_MAX_LEADS_PER_24H`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/robert/robertJohnBridge.js:L58` (process.env)
  - `tests/unit/robert-john-bridge.test.mjs:L209–L227` (process.env)

### `ROBERT_MODE`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/robert-agent-silent-failure.test.mjs:L30` (process.env)
  - `tests/unit/robert-agent.test.mjs:L15` (process.env)
  - `tests/unit/robert-safety.test.mjs:L30` (process.env)

### `ROBERT_SCAN_EMAIL_CONTACTS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/robert/robertContactDiscovery.js:L40` (process.env)

### `ROBERT_SCHEDULED_MODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/robert/robertScheduler.js:L97` (process.env)

### `RUNTIME_SECRETS_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/hamiltonCredentialFallback.test.js:L16` (process.env)
  - `backend/tests/hamiltonPortalAutopilotIdentity.test.js:L19` (process.env)
  - `backend/tests/hamiltonPortalSignupAdapter.test.js:L17` (process.env)
  - `backend/tests/portalAutopilotCobrowseAndMerge.test.js:L19` (process.env)
  - `backend/tests/portalAutopilotPassphraseReset.test.js:L18–L18` (process.env)
  - `backend/tests/portalCompletionAndReminder.test.js:L15` (process.env)
  - `backend/tests/portalSyncRequiresSession.test.js:L12` (process.env)
  - `backend/tests/profilePortalIndex.test.js:L13` (process.env)
  - `backend/tests/profilePortalsUnlockRoute.test.js:L24–L24` (process.env)
  - `backend/utils/runtimeSecrets.js:L4` (process.env)
  - `tests/unit/hamilton-auth-backup-plan.test.mjs:L27` (process.env)
  - `tests/unit/hamilton-credential-csv-import.test.mjs:L38` (process.env)
  - `tests/unit/hamilton-credential-vault-management.test.mjs:L32` (process.env)
  - `tests/unit/hamilton-document-resume.test.mjs:L20` (process.env)
  - `tests/unit/hamilton-missing-info-alert.test.mjs:L18` (process.env)
  - `tests/unit/hamilton-missing-info-resume.test.mjs:L22` (process.env)
  - `tests/unit/hamilton-parse-reconcile.test.mjs:L20` (process.env)
  - `tests/unit/hamilton-portal-credential-vault.test.mjs:L40` (process.env)

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
  - `backend/start.js:L110` (process.env)

### `SAM_AUTO_FIX_SAFE`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/samPolicy.test.js:L93–L104` (process.env)

### `SAM_CHECK_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samDiagnostics.js:L53` (process.env)

### `SAM_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samScheduler.js:L33` (process.env)

### `SAM_GOV_API_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/connectors/samGovConnector.js:L22` (process.env)

### `SAM_GOV_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/grantsGovEndpoints.js:L48` (process.env)
  - `backend/services/diagnosticsService.js:L390` (process.env)
  - `backend/tests/samDiscoveryAwareness.test.js:L216` (process.env)
  - `backend/tests/samGovApiKey.test.js:L11–L61` (process.env)
  - `tests/unit/funding-api-keys.test.mjs:L32–L37` (process.env)

### `SAM_GOV_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/grantsGovEndpoints.js:L50` (process.env)

### `SAM_GOV_PUBLIC_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/config/grantsGovEndpoints.js:L47` (process.env)
  - `backend/services/connectorIngestService.js:L436` (process.env)
  - `backend/services/diagnosticsService.js:L390` (process.env)
  - `backend/src/integrations/samAssistanceListings.js:L29–L74` (process.env)
  - `backend/tests/samDiscoveryAwareness.test.js:L203–L215` (process.env)
  - `backend/tests/samGovApiKey.test.js:L11–L60` (process.env)
  - `tests/unit/funding-api-keys.test.mjs:L31–L36` (process.env)

### `SAM_HTTP_PROBE_TIMEOUT_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samHttpProbe.js:L23` (process.env)

### `SAM_MAX_FIXES_PER_RUN`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samAgent.js:L540` (process.env)

### `SAM_MODE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samAgent.js:L406` (process.env)
  - `backend/services/sam/samScheduler.js:L45` (process.env)

### `SAM_RUN_ON_SCHEDULE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samScheduler.js:L41` (process.env)

### `SAM_RUN_ON_STARTUP`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samScheduler.js:L37` (process.env)

### `SAM_SCHEDULE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/sam/samAgent.js:L407` (process.env)
  - `backend/services/sam/samScheduler.js:L107–L125` (process.env)

### `SCHOOL_PORTAL_VERIFY_BASE`

- **Templates**: (not present)
- **Code references**:
  - `scripts/verify-school-portal-live.mjs:L25` (process.env)

### `SEARXNG_ENGINES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/shared/searxngProvider.js:L59` (process.env)

### `SEARXNG_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/shared/searxngProvider.js:L47–L56` (process.env)
  - `backend/services/shared/webSearchEngine.js:L50` (process.env)
  - `backend/tests/webSearchEngine.test.js:L51–L142` (process.env)

### `SEED_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/admin.js:L3587` (process.env)

### `SEED_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/seed-profiles.mjs:L51–L52` (process.env)

### `SENDGRID_API_KEY`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/onboardingRoute.test.js:L182` (process.env)

### `SENTRY_DSN`

- **Templates**:
  - `backend/env.example:178` = ``
- **Code references**: (none)

### `SERVICE_APPLICATION_EMAIL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/serviceApplication.js:L14` (process.env)

### `SERVICE_CATALOG_SEED_TTL_MS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/serviceCatalogStore.js:L28` (process.env)

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
  - `backend/services/connectorIngestService.js:L435` (process.env)
  - `backend/services/connectors/grantsGovConnector.js:L172` (process.env)
  - `backend/services/diagnosticsService.js:L392` (process.env)
  - `backend/services/shared/grantsGovClient.js:L34` (process.env)
  - `tests/unit/funding-api-keys.test.mjs:L11–L35` (process.env)

### `SKIP_NETWORK_TESTS`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/known-schools-liveness.test.mjs:L37` (process.env)

### `SMART_MATCHER_INTENT_MODEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/smartMatcherIntent.js:L806` (process.env)

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
  - `backend/services/comprehensiveCrawlerOptimized.js:L581–L601` (process.env)
  - `backend/start.js:L24–L33` (process.env)
  - `backend/tests/testServer.js:L15` (process.env)
  - `tests/e2e/playwright.config.mjs:L38` (process.env)
  - `tests/unit/startup-smoke-mode.test.mjs:L51` (process.env)

### `SMOKE_TARGET_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-login.mjs:L30` (process.env)

### `SMS_CONSENT_MESSAGE`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/comms/smsConsentService.js:L60` (process.env)

### `SMS_CONSENT_PENDING_EXPIRE_DAYS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/comms/smsConsentService.js:L372` (process.env)

### `SMTP_HOST`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/onboardingRoute.test.js:L184` (process.env)

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
  - `.env.example:491` = `backend/data/grantflow.dev.db`
  - `backend/env.example:11` = `backend/data/grantflow.dev.db`
- **Code references**:
  - `backend/db/index.js:L115` (process.env)
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L312` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L163` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L7` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L10` (process.env)
  - `backend/start.js:L49` (process.env)
  - `backend/tests/testServer.js:L20` (process.env)
  - `scripts/audit-section-metadata.mjs:L62` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L42` (process.env)

### `SQLITE_PATH`

- **Templates**: (not present)
- **Code references**:
  - `scripts/probe-deferred-rcs.mjs:L22` (process.env)

### `STARTUP_PROFILE_JOB_REPAIR_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/startup/selfHeal.js:L165` (process.env)

### `STARTUP_PROFILE_ORG_LINK_LIMIT`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L1223` (process.env)
  - `backend/startup/selfHeal.js:L141` (process.env)

### `STARTUP_SMOKE_CRAWL_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3024` (process.env)
  - `backend/startup/backgroundServices.js:L190` (process.env)

### `STRIPE_MOCK`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/pricing/stripePriceVerifier.js:L37` (process.env)
  - `backend/services/stripeService.js:L51–L140` (process.env)
  - `tests/unit/charge-resolver.test.mjs:L16` (process.env)
  - `tests/unit/sam-pricing-stripe-auditor.test.mjs:L15` (process.env)
  - `tests/unit/stripe-price-verifier.test.mjs:L11` (process.env)

### `STRIPE_SECRET_KEY`

- **Templates**:
  - `backend/env.example:86` = ``
- **Code references**:
  - `backend/services/billing/invoiceService.js:L152–L230` (process.env)
  - `backend/services/pricing/stripePriceVerifier.js:L41` (process.env)
  - `backend/services/stripeService.js:L9` (process.env)

### `STRIPE_WEBHOOK_SECRET`

- **Templates**:
  - `backend/env.example:87` = ``
- **Code references**:
  - `backend/services/stripeService.js:L14–L171` (process.env)

### `SWEEP_DEBUG`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/endpointSweep.test.js:L95` (process.env)

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
  - `scripts/opportunities-national-minimum.mjs:L140` (process.env)

### `TEST_ZIP`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/testServer.js:L94` (process.env)

### `TWILIO_ACCOUNT_SID`

- **Templates**:
  - `backend/env.example:74` = `ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L150` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L32` (process.env)
  - `backend/services/diagnosticsService.js:L405` (process.env)
  - `backend/services/sms.js:L20–L29` (process.env)

### `TWILIO_AUTH_TOKEN`

- **Templates**:
  - `backend/env.example:75` = `your-twilio-auth-token`
- **Code references**:
  - `backend/routes/auth.js:L151` (process.env)
  - `backend/routes/smsInbound.js:L41–L46` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L33` (process.env)
  - `backend/services/diagnosticsService.js:L405` (process.env)
  - `backend/services/sms.js:L21–L30` (process.env)

### `TWILIO_FROM_NUMBER`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L153` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L40` (process.env)
  - `backend/services/sms.js:L23–L40` (process.env)

### `TWILIO_MESSAGING_SERVICE_SID`

- **Templates**:
  - `backend/env.example:76` = `MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- **Code references**:
  - `backend/routes/auth.js:L152` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L40–L103` (process.env)
  - `backend/services/sms.js:L22–L80` (process.env)

### `TWILIO_PUBLIC_BASE_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/smsInbound.js:L53` (process.env)

### `TWILIO_VALIDATE_SIGNATURE`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/smsInbound.js:L37` (process.env)

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
  - `backend/routes/health.js:L238` (process.env)
  - `backend/server.js:L312` (process.env)
  - `backend/services/anyaOrchestrator.js:L1543` (process.env)
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
  - `backend/server.js:L254–L284` (process.env)
  - `backend/services/opportunityInserter.js:L109` (process.env)
  - `backend/startup/bootstrap.js:L428–L455` (process.env)

### `USERPROFILE`

- **Templates**: (not present)
- **Code references**:
  - `.cursor/skills/impeccable/scripts/hook-lib.mjs:L1238` (process.env)

### `VEHICLES_INGEST_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/vehicles.js:L36` (process.env)

### `VERCEL`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L53` (process.env)
  - `scripts/ensure-build-natives.mjs:L90` (process.env)

### `VERCEL_ENV`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/auth.js:L296` (process.env)
  - `backend/utils/environment.js:L14–L24` (process.env)

### `VERCEL_GIT_COMMIT_SHA`

- **Templates**: (not present)
- **Code references**:
  - `backend/routes/health.js:L46` (process.env)
  - `backend/server.js:L2107` (process.env)
  - `backend/startup/backgroundServices.js:L418` (process.env)

### `VERIFICATION_CACHE_MAX_ENTRIES`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/verification/verificationCache.js:L21` (process.env)

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

### `VITE_API_URL`

- **Templates**: (not present)
- **Code references**:
  - `src/api/client.js:L16` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L62–L168` (import.meta.env)
  - `src/config/env.js:L34` (import.meta.env)

### `VITE_APP_BASE`

- **Templates**:
  - `.env.example:18` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L158` (process.env)
  - `backend/server.js:L210–L660` (process.env)
  - `scripts/doctor.mjs:L81–L180` (process.env)
  - `src/components/auth/SessionExpiredDialog.jsx:L10` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L25` (import.meta.env)
  - `src/config/env.js:L33` (import.meta.env)
  - `src/utils/enforceBasename.js:L13` (import.meta.env)
  - `src/utils/index.js:L27` (import.meta.env)
  - `tests/e2e/playwright.config.mjs:L10` (process.env)
  - `tests/helpers/backendHarness.mjs:L84` (process.env)
  - `tests/smoke/playwright.config.mjs:L5` (process.env)
  - `tests/unit/anya-tasks.test.mjs:L58` (process.env)
  - `tests/unit/api-contracts.test.mjs:L79` (process.env)

### `VITE_ASSET_BASE`

- **Templates**: (not present)
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
  - `src/components/auth/SocialSignInButtons.jsx:L164` (import.meta.env)
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
  - `src/pages/Pricing.jsx:L287–L290` (import.meta.env)

### `VITE_SUPPORT_FAX`

- **Templates**: (not present)
- **Code references**:
  - `src/pages/Pricing.jsx:L295` (import.meta.env)

### `WEEKLY_VERIFY_CHUNKS`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L3289` (process.env)

### `X_ADMIN_TOKEN`

- **Templates**: (not present)
- **Code references**:
  - `scripts/smoke-docs-local.mjs:L18` (process.env)

### `YANA_ALLOW_LIVE_WEB`

- **Templates**: (not present)
- **Code references**:
  - `backend/server.js:L2653` (process.env)

### `YANA_CAP_WINDOW_HOURS`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L53` (process.env)

### `YANA_DAILY_LEAD_CAP`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L52` (process.env)

### `YANA_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/yanaScheduler.test.js:L93` (process.env)
  - `tests/unit/yana-leads-scheduler.test.mjs:L83` (process.env)

### `YANA_ENRICH_CONCURRENCY`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L190` (process.env)

### `YANA_LEADS_ENABLED`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L153–L175` (process.env)

### `YANA_LEADS_RUN_ON_SCHEDULE`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L154–L176` (process.env)

### `YANA_LEADS_RUN_ON_STARTUP`

- **Templates**: (not present)
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L155–L177` (process.env)

### `YANA_QUALIFY_THRESHOLD`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L47` (process.env)

### `YANA_RUN_ON_SCHEDULE`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/yanaScheduler.test.js:L95` (process.env)

### `YANA_RUN_ON_STARTUP`

- **Templates**: (not present)
- **Code references**:
  - `backend/tests/yanaScheduler.test.js:L94` (process.env)

### `YANA_WEB_CSV_FEED_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/yana/yanaWebCrawler.js:L411` (process.env)

### `YANA_WEB_JSON_FEED_URL`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/yana/yanaWebCrawler.js:L398` (process.env)

### `ZIP_COUNTY_MAP_PATH`

- **Templates**: (not present)
- **Code references**:
  - `backend/services/geo/zipCountyResolver.js:L15–L15` (process.env)
