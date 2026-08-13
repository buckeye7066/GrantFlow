# ENV Vars Inventory

This file is generated from first-party source present in the checkout and the generated
example templates. “Referenced” means a static source reference; “Listed in
templates” includes commented optional entries. Presence here does not prove that a
variable is required, configured in Vercel/Railway, or safe to log; production
requirements remain in `docs/ENVIRONMENT.md`.

## Summary

- Total vars: **930**
- Vars referenced in code: **930**
- Vars listed in env templates: **927**

## Inventory

| Name | Referenced in code | Listed in templates | Notes |
| --- | --- | --- | --- |
| `ACCESS_TOKEN` | Yes | Yes | Backend/Node |
| `ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `ADMIN_EMAILS` | Yes | Yes | Backend/Node |
| `ADMIN_HEALTH_TOKEN` | Yes | Yes | Backend/Node |
| `ADMIN_LOGIN_EVENT_BUFFER` | Yes | Yes | Backend/Node |
| `ADMIN_NAME` | Yes | Yes | Backend/Node |
| `ADMIN_OPS_EMAIL` | Yes | Yes | Backend/Node |
| `ADMIN_PHONE` | Yes | Yes | Backend/Node |
| `ADMIN_RUN_SOURCE_BUDGET_MS` | Yes | Yes | Backend/Node |
| `ADMIN_SELF_BASE_URL` | Yes | Yes | Backend/Node |
| `ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ADVERSARIAL_AUTHOR_MAX_TOKENS` | Yes | Yes | Backend/Node |
| `ADVERSARIAL_AUTHOR_MODEL` | Yes | Yes | Backend/Node |
| `ADVERSARIAL_GATE_POLL_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `ADVERSARIAL_GATE_POLL_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `ADVERSARIAL_MAX_AUTHOR_FILE_CHARS` | Yes | Yes | Backend/Node |
| `ADVERSARIAL_MAX_VERIFY_DIFF_CHARS` | Yes | Yes | Backend/Node |
| `ADVERSARIAL_VERIFIER_MAX_TOKENS` | Yes | Yes | Backend/Node |
| `ADVERSARIAL_VERIFIER_MODEL` | Yes | Yes | Backend/Node |
| `AGENT_CONTROL_ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `ALERT_FAILURE_THRESHOLD` | Yes | Yes | Backend/Node |
| `ALERT_QUEUE_BACKLOG_THRESHOLD` | Yes | Yes | Backend/Node |
| `ALLOW_AUTO_ROUTE_GENERATION` | Yes | Yes | Backend/Node |
| `ALLOW_DESTRUCTIVE_SEED` | Yes | Yes | Backend/Node |
| `ALLOW_DEV_FILESYSTEM_AUDIT_LOGS` | Yes | Yes | Backend/Node |
| `ALLOW_EPHEMERAL_SQLITE` | Yes | Yes | Backend/Node |
| `ALLOW_EPHEMERAL_UPLOADS` | Yes | Yes | Backend/Node |
| `ALLOW_LEGACY_PROFILE_TOKEN` | Yes | Yes | Backend/Node |
| `ALLOW_OTP_LOGIN` | Yes | Yes | Backend/Node |
| `ALLOW_SQLITE_IN_PROD` | Yes | Yes | Backend/Node |
| `AMOUNT_ENRICH_BOOT_LIMIT` | Yes | Yes | Backend/Node |
| `AMOUNT_ENRICH_ENV_MAX_ATTEMPTS` | Yes | Yes | Backend/Node |
| `AMOUNT_ENRICH_ENV_REPROBE_LIMIT` | Yes | Yes | Backend/Node |
| `AMOUNT_ENRICH_MAX_ATTEMPTS` | Yes | Yes | Backend/Node |
| `AMOUNT_ENRICH_SYSTEMIC_STREAK` | Yes | Yes | Backend/Node |
| `AMOUNT_ENRICH_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `AMY_ADVERSARIAL` | Yes | Yes | Backend/Node |
| `AMY_ADVERSARIAL_SHARE` | Yes | Yes | Backend/Node |
| `AMY_ANYA_APPLY` | Yes | Yes | Backend/Node |
| `AMY_APPLY_COVERAGE` | Yes | Yes | Backend/Node |
| `AMY_APPLY_LEARNING` | Yes | Yes | Backend/Node |
| `AMY_APPLY_TUNING` | Yes | Yes | Backend/Node |
| `AMY_APPLY_WEIGHTS` | Yes | Yes | Backend/Node |
| `AMY_APPROVAL_LEDGER` | Yes | Yes | Backend/Node |
| `AMY_APPROVAL_STALE_NIGHTS` | Yes | Yes | Backend/Node |
| `AMY_AUTO_CLEANUP` | Yes | Yes | Backend/Node |
| `AMY_CLEANUP_GRACE_HOURS` | Yes | Yes | Backend/Node |
| `AMY_CRAWLER_RESEARCH` | Yes | Yes | Backend/Node |
| `AMY_DAILY_PROFILE_TARGET` | Yes | Yes | Backend/Node |
| `AMY_ENABLED` | Yes | Yes | Backend/Node |
| `AMY_FLOOR` | Yes | Yes | Backend/Node |
| `AMY_FLYWHEEL_REPORT_EMAIL` | Yes | Yes | Backend/Node |
| `AMY_GAP_LEARNING` | Yes | Yes | Backend/Node |
| `AMY_GAP_SCAN_LIMIT` | Yes | Yes | Backend/Node |
| `AMY_IMPROVE` | Yes | Yes | Backend/Node |
| `AMY_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `AMY_KEEP_PROFILES` | Yes | Yes | Backend/Node |
| `AMY_NEVER_CRAWLED_MAX_AGE_HOURS` | Yes | Yes | Backend/Node |
| `AMY_PERSIST` | Yes | Yes | Backend/Node |
| `AMY_PROBE_COVERAGE` | Yes | Yes | Backend/Node |
| `AMY_REPO_REWARDS` | Yes | Yes | Backend/Node |
| `AMY_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `AMY_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `AMY_SAM_APPLY` | Yes | Yes | Backend/Node |
| `ANTHROPIC_API_KEY` | Yes | Yes | Backend/Node |
| `ANTHROPIC_MAX_RETRIES` | Yes | Yes | Backend/Node |
| `ANTHROPIC_MODEL` | Yes | Yes | Backend/Node |
| `ANTHROPIC_MODEL_SCHOOL_LOOKUP` | Yes | Yes | Backend/Node |
| `ANTHROPIC_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_GEO_COOLDOWN_HOURS` | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_GEO_OVERPASS_MAX` | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_GEO_OVERPASS_RADIUS_KM` | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_GEO_STATE_PACING_MS` | Yes | Yes | Backend/Node |
| `ANYA_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ANYA_ANTHROPIC_COOLDOWN_MS` | Yes | Yes | Backend/Node |
| `ANYA_ANTHROPIC_FAILURE_THRESHOLD` | Yes | Yes | Backend/Node |
| `ANYA_ANTHROPIC_MAX_RETRIES` | Yes | Yes | Backend/Node |
| `ANYA_ANTHROPIC_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `ANYA_API_KEY` | Yes | Yes | Backend/Node |
| `ANYA_AUTONOMOUS_ENABLED` | Yes | Yes | Backend/Node |
| `ANYA_BG_REPLY_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `ANYA_CHECK_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ANYA_CHECK_API_BASE` | Yes | Yes | Backend/Node |
| `ANYA_CODE_CRAWL` | Yes | Yes | Backend/Node |
| `ANYA_CODE_REPAIR_PRODUCTION_WRITES` | Yes | Yes | Backend/Node |
| `ANYA_CRAWLERS` | Yes | Yes | Backend/Node |
| `ANYA_DAILY_REPORT_EMAIL` | Yes | Yes | Backend/Node |
| `ANYA_DAILY_REPORT_ENABLED` | Yes | Yes | Backend/Node |
| `ANYA_DAILY_REPORT_HOUR_ET` | Yes | Yes | Backend/Node |
| `ANYA_DRY_RUN` | Yes | Yes | Backend/Node |
| `ANYA_FIX_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ANYA_FIX_API_BASE` | Yes | Yes | Backend/Node |
| `ANYA_FIX_CONFIRM` | Yes | Yes | Backend/Node |
| `ANYA_FIX_CONFIRM_MUTATING_HOST` | Yes | Yes | Backend/Node |
| `ANYA_FIX_CONSOLE` | Yes | Yes | Backend/Node |
| `ANYA_FIX_EMPTY_CATCH` | Yes | Yes | Backend/Node |
| `ANYA_FIX_ERRORS` | Yes | Yes | Backend/Node |
| `ANYA_FUNCTION_TESTS` | Yes | Yes | Backend/Node |
| `ANYA_FUNCTION_TEST_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `ANYA_GEO_CRAWL` | Yes | Yes | Backend/Node |
| `ANYA_HEALTH_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `ANYA_ITEM_DISCOVERY` | Yes | Yes | Backend/Node |
| `ANYA_ITEM_DISCOVERY_LIMIT` | Yes | Yes | Backend/Node |
| `ANYA_ITEM_DISCOVERY_MIN_COUNT` | Yes | Yes | Backend/Node |
| `ANYA_LEGACY_CRAWLER_CONTEXT_WARNING` | Yes | Yes | Backend/Node |
| `ANYA_MATCH_SCOUT` | Yes | Yes | Backend/Node |
| `ANYA_MATCH_SCOUT_CANDIDATE_LIMIT` | Yes | Yes | Backend/Node |
| `ANYA_MATCH_SCOUT_MAX_ALERTS_PER_PROFILE` | Yes | Yes | Backend/Node |
| `ANYA_MATCH_SCOUT_THRESHOLD` | Yes | Yes | Backend/Node |
| `ANYA_MAX_FILE_CHANGES` | Yes | Yes | Backend/Node |
| `ANYA_OPENAI_COOLDOWN_MS` | Yes | Yes | Backend/Node |
| `ANYA_OPENAI_FAILURE_THRESHOLD` | Yes | Yes | Backend/Node |
| `ANYA_OPENAI_MAX_RETRIES` | Yes | Yes | Backend/Node |
| `ANYA_OPENAI_MODEL` | Yes | Yes | Backend/Node |
| `ANYA_OPENAI_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `ANYA_PORTAL_CHECKS` | Yes | Yes | Backend/Node |
| `ANYA_REPLY_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_ADMIN_LOGIN` | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `ANYA_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `ANYA_SAVE_GLOBAL` | Yes | Yes | Backend/Node |
| `ANYA_SCHEDULE` | Yes | Yes | Backend/Node |
| `ANYA_SELF_BASE_URL` | Yes | Yes | Backend/Node |
| `ANYA_TOOL_FAILURE_WINDOW_HOURS` | Yes | Yes | Backend/Node |
| `ANYA_USAGE_RETENTION_DAYS` | Yes | Yes | Backend/Node |
| `ANYA_WAIT_COMPLETION` | Yes | Yes | Backend/Node |
| `API_BASE` | Yes | Yes | Backend/Node |
| `API_BASE_URL` | Yes | Yes | Backend/Node |
| `API_DATA_GOV_KEY` | Yes | Yes | Backend/Node |
| `API_URL` | Yes | Yes | Backend/Node |
| `APPLICATION_EMAIL` | Yes | Yes | Backend/Node |
| `APPLY` | Yes | Yes | Backend/Node |
| `APPLY_STORAGE_DIR` | Yes | Yes | Backend/Node |
| `APP_BASE_PATH` | Yes | Yes | Backend/Node |
| `AUTH_ACCESS_TOKEN_TTL` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_CODE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_FROM` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_MAX_VERIFY_ATTEMPTS` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_RATE_LIMIT` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_RESEND_SECONDS` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_SEND_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `AUTH_EMAIL_VERIFY_RATE_LIMIT` | Yes | Yes | Backend/Node |
| `AUTH_FRONTEND_APP_BASE` | Yes | Yes | Backend/Node |
| `AUTH_FRONTEND_URL` | Yes | Yes | Backend/Node |
| `AUTH_JWT_SECRET` | Yes | Yes | Backend/Node |
| `AUTH_NOTIFY_EMAIL` | Yes | Yes | Backend/Node |
| `AUTH_NOTIFY_ON_LOGIN` | Yes | Yes | Backend/Node |
| `AUTH_OAUTH_STATE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PASSWORD_RATE_LIMIT` | Yes | Yes | Backend/Node |
| `AUTH_PASSWORD_SETUP_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_CODE_TTL` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_MAX_VERIFY_ATTEMPTS` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_RATE_LIMIT` | Yes | Yes | Backend/Node |
| `AUTH_PHONE_RESEND_SECONDS` | Yes | Yes | Backend/Node |
| `AUTH_PUBLIC_URL` | Yes | Yes | Backend/Node |
| `AUTH_REFRESH_RACE_GRACE_MS` | Yes | Yes | Backend/Node |
| `AUTH_REFRESH_TOKEN_TTL` | Yes | Yes | Backend/Node |
| `AUTH_TOKEN` | Yes | Yes | Backend/Node |
| `AUTO_DISCOVERY_DAILY_ENABLED` | Yes | Yes | Backend/Node |
| `AUTO_DISCOVERY_DAILY_HOUR` | Yes | Yes | Backend/Node |
| `AUTO_POPULATE_PER_SECTION_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `AUTO_POPULATE_TOTAL_BUDGET_MS` | Yes | Yes | Backend/Node |
| `AWS_ACCESS_KEY_ID` | Yes | Yes | Backend/Node |
| `AWS_DEFAULT_REGION` | Yes | Yes | Backend/Node |
| `AWS_REGION` | Yes | Yes | Backend/Node |
| `AWS_SECRET_ACCESS_KEY` | Yes | Yes | Backend/Node |
| `AWS_SESSION_TOKEN` | Yes | Yes | Backend/Node |
| `BACKEND_BASE_URL` | Yes | Yes | Backend/Node |
| `BACKEND_PORT` | Yes | Yes | Backend/Node |
| `BASELINE_SEED_MODE` | Yes | Yes | Backend/Node |
| `BASE_URL` | Yes | Yes | Used in both backend + frontend |
| `BEARER_TOKEN` | Yes | Yes | Backend/Node |
| `BEHAVIOR_LEARNING_ENABLED` | Yes | Yes | Backend/Node |
| `BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE` | Yes | Yes | Backend/Node |
| `BILLING_AUTOMATION_ENABLED` | Yes | Yes | Backend/Node |
| `BILLING_CYCLE_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `BILLING_OWNER_CC` | Yes | Yes | Backend/Node |
| `BILLING_SECOND_NOTICE_DAYS` | Yes | Yes | Backend/Node |
| `BILLING_SUSPEND_DAYS` | Yes | Yes | Backend/Node |
| `BLOCKLIST_INGEST_TOKEN` | Yes | Yes | Backend/Node |
| `BRAVE_BUDGET_ENABLED` | Yes | Yes | Backend/Node |
| `BRAVE_BUDGET_MIN_DAILY` | Yes | Yes | Backend/Node |
| `BRAVE_MONTHLY_QUERY_BUDGET` | Yes | Yes | Backend/Node |
| `BRAVE_SEARCH_API_KEY` | Yes | Yes | Backend/Node |
| `BROADCAST_FROM_EMAIL` | Yes | Yes | Backend/Node |
| `BUILD_TIME` | Yes | Yes | Backend/Node |
| `BUILD_TIMESTAMP` | Yes | Yes | Backend/Node |
| `BULK_POPULATE_KEY` | Yes | Yes | Backend/Node |
| `CATALOG_RESCORE_PAIR_BUDGET` | Yes | Yes | Backend/Node |
| `CATALOG_RESCORE_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `CENSUS_GEO_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `CI` | Yes | Yes | Backend/Node |
| `CLOUD_LOGIN_KEYFRAME_MS` | Yes | Yes | Backend/Node |
| `CODEQL_SCAN_EVENT` | Yes | Yes | Backend/Node |
| `CODEQL_SCAN_REPOSITORY` | Yes | Yes | Backend/Node |
| `CODEQL_SCAN_SHA` | Yes | Yes | Backend/Node |
| `COMMIT_AUDIT_OUT_PATH` | Yes | Yes | Backend/Node |
| `COMMIT_SHA` | Yes | Yes | Backend/Node |
| `COMPARABLE_AWARDS` | Yes | Yes | Backend/Node |
| `COMPREHENSIVE_GEO_JOB_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `COMPREHENSIVE_JOB_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `COMPREHENSIVE_TEST_ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `COMPREHENSIVE_TEST_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `COMPREHENSIVE_TEST_API_BASE` | Yes | Yes | Backend/Node |
| `COMPREHENSIVE_TEST_CONFIRM` | Yes | Yes | Backend/Node |
| `COMPREHENSIVE_TEST_CONFIRM_MUTATING_HOST` | Yes | Yes | Backend/Node |
| `COMPUTERNAME` | Yes | Yes | Backend/Node |
| `CONFIRM` | Yes | Yes | Backend/Node |
| `CONNECTOR_INGEST_MAX_TERMS` | Yes | Yes | Backend/Node |
| `CORE_TIMEOUT_MINUTES` | Yes | Yes | Backend/Node |
| `CORS_ORIGIN` | Yes | Yes | Backend/Node |
| `COUNTRIES` | Yes | Yes | Backend/Node |
| `COUNTY_FUNDING_CRAWLER_ENABLED` | Yes | Yes | Backend/Node |
| `COVERAGE_AUTOHEAL_ENABLED` | Yes | Yes | Backend/Node |
| `COVERAGE_AUTOHEAL_MAX` | Yes | Yes | Backend/Node |
| `CRAWLER_BROWSER_HEADERS` | Yes | Yes | Backend/Node |
| `CRAWLER_COVERAGE_FAILURE_THRESHOLD` | Yes | Yes | Backend/Node |
| `CRAWLER_COVERAGE_WINDOW_HOURS` | Yes | Yes | Backend/Node |
| `CRAWLER_DATA_DIR` | Yes | Yes | Backend/Node |
| `CRAWLER_DISPATCH_BASE_DELAY_MS` | Yes | Yes | Backend/Node |
| `CRAWLER_DISPATCH_MAX_ATTEMPTS` | Yes | Yes | Backend/Node |
| `CRAWLER_DISPATCH_MAX_DELAY_MS` | Yes | Yes | Backend/Node |
| `CRAWLER_FETCH_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `CRAWLER_FLOOR` | Yes | Yes | Backend/Node |
| `CRAWLER_GAP_LEARNING_ENABLED` | Yes | Yes | Backend/Node |
| `CRAWLER_JOB_STUCK_THRESHOLD_MS` | Yes | Yes | Backend/Node |
| `CRAWLER_JOB_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `CRAWLER_MAX_CONCURRENCY` | Yes | Yes | Backend/Node |
| `CRAWLER_MAX_RETRY_DELAY` | Yes | Yes | Backend/Node |
| `CRAWLER_MAX_SOURCES` | Yes | Yes | Backend/Node |
| `CRAWLER_MIN_FLOOR` | Yes | Yes | Backend/Node |
| `CRAWLER_OS_ALLOW_LEGACY` | Yes | Yes | Backend/Node |
| `CRAWLER_PROFILE_ID` | Yes | Yes | Backend/Node |
| `CRAWLER_RETRY_BASE_DELAY` | Yes | Yes | Backend/Node |
| `CRAWLER_SOURCE_FAILURE_STREAK` | Yes | Yes | Backend/Node |
| `CRAWLER_STALE_CLEANUP_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `CRAWLER_STALE_DAYS` | Yes | Yes | Backend/Node |
| `CRAWLER_STALE_HEARTBEAT_MS` | Yes | Yes | Backend/Node |
| `CRAWLER_STALE_RUNNING_MS` | Yes | Yes | Backend/Node |
| `CRAWL_FALLBACK_RESERVE_MS` | Yes | Yes | Backend/Node |
| `CRAWL_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `CRAWL_TOTAL_BUDGET_MS` | Yes | Yes | Backend/Node |
| `DATABASE_PATH` | Yes | Yes | Backend/Node |
| `DATABASE_PUBLIC_URL` | Yes | Yes | Backend/Node |
| `DATABASE_URL` | Yes | Yes | Backend/Node |
| `DB_AUTO_MIGRATE` | Yes | Yes | Backend/Node |
| `DB_DIALECT` | Yes | Yes | Backend/Node |
| `DB_PATH` | Yes | Yes | Backend/Node |
| `DB_POOL_MAX` | Yes | Yes | Backend/Node |
| `DB_PROVIDER` | Yes | Yes | Backend/Node |
| `DEAD_URL_REPAIR_BOOT_LIMIT` | Yes | Yes | Backend/Node |
| `DEAD_URL_REPAIR_COOLDOWN_MS` | Yes | Yes | Backend/Node |
| `DEAD_URL_REPAIR_MAX_ATTEMPTS` | Yes | Yes | Backend/Node |
| `DEAD_URL_REPAIR_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `DEDUPE_BASE_URL` | Yes | Yes | Backend/Node |
| `DEPLOY_ENV` | Yes | Yes | Backend/Node |
| `DEPLOY_TIMESTAMP` | Yes | Yes | Backend/Node |
| `DESIGNATED_PROFILES_FILE` | Yes | Yes | Backend/Node |
| `DEV` | Yes | No | Frontend (Vite) |
| `DIRECT_LAND_TOKEN_TTL_MS` | Yes | Yes | Backend/Node |
| `DISABLE_BACKGROUND_SERVICES` | Yes | Yes | Backend/Node |
| `DISABLE_SEEDING` | Yes | Yes | Backend/Node |
| `DISK_USAGE_WARN_PCT` | Yes | Yes | Backend/Node |
| `DOMAIN_CORPUS_CRAWL_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `DRY_RUN` | Yes | Yes | Backend/Node |
| `E2E_ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `E2E_BASE_PATH` | Yes | Yes | Backend/Node |
| `E2E_BASE_URL` | Yes | Yes | Backend/Node |
| `E2E_PORT` | Yes | Yes | Backend/Node |
| `ECF_LIVE_FETCH_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `ECF_LIVE_FETCH_USER_AGENT` | Yes | Yes | Backend/Node |
| `EMAIL_FROM` | Yes | Yes | Backend/Node |
| `EMAIL_GRANTS_INGEST_TOKEN` | Yes | Yes | Backend/Node |
| `EMAIL_GRANTS_SYNC_CRON` | Yes | Yes | Backend/Node |
| `EMAIL_GRANTS_SYNC_ENABLED` | Yes | Yes | Backend/Node |
| `EMAIL_GRANTS_SYNC_TOP` | Yes | Yes | Backend/Node |
| `EMAIL_GRANTS_SYNC_TZ` | Yes | Yes | Backend/Node |
| `EMBEDDING_MODEL` | Yes | Yes | Backend/Node |
| `ENABLE_CENSUS_GEO` | Yes | Yes | Backend/Node |
| `ENABLE_MIN_NATIONAL_ENSURE` | Yes | Yes | Backend/Node |
| `ENABLE_REGISTRY_VERIFICATION` | Yes | Yes | Backend/Node |
| `ENFORCE_AMOUNT_ENRICHMENT` | Yes | Yes | Backend/Node |
| `ENFORCE_AMY_SYNTHETIC_EXPIRY` | Yes | Yes | Backend/Node |
| `ENFORCE_CANONICAL_PROGRAM_TARGETS` | Yes | Yes | Backend/Node |
| `ENFORCE_CATALOG_RESCORE` | Yes | Yes | Backend/Node |
| `ENFORCE_CONDITION_LANE_SCOPE` | Yes | Yes | Backend/Node |
| `ENFORCE_COUNTY_CRISIS_RECALL` | Yes | Yes | Backend/Node |
| `ENFORCE_DEAD_URL_REPAIR` | Yes | Yes | Backend/Node |
| `ENFORCE_DECLARED_GEO_SCOPE` | Yes | Yes | Backend/Node |
| `ENFORCE_DECLARED_PLACE_SCOPE` | Yes | Yes | Backend/Node |
| `ENFORCE_FIELD_OF_STUDY_LINK` | Yes | Yes | Backend/Node |
| `ENFORCE_FOREIGN_JURISDICTION_SCOPE` | Yes | Yes | Backend/Node |
| `ENFORCE_FUNDER_990_INGEST` | Yes | Yes | Backend/Node |
| `ENFORCE_FUNDER_BEHAVIOR_RECALL` | Yes | Yes | Backend/Node |
| `ENFORCE_GRANT_AMOUNT_BACKFILL` | Yes | Yes | Backend/Node |
| `ENFORCE_GRANT_CATALOG_LINK` | Yes | Yes | Backend/Node |
| `ENFORCE_GRANT_DIRECT_AMOUNT` | Yes | Yes | Backend/Node |
| `ENFORCE_GRANT_SCORE_BACKFILL` | Yes | Yes | Backend/Node |
| `ENFORCE_HAMILTON_STOP_RECHECK` | Yes | Yes | Backend/Node |
| `ENFORCE_HAMILTON_TASK_SELF_HEAL` | Yes | Yes | Backend/Node |
| `ENFORCE_INDIVIDUAL_AMOUNT_CEILING` | Yes | Yes | Backend/Node |
| `ENFORCE_INDIVIDUAL_MATCH_CEILING` | Yes | Yes | Backend/Node |
| `ENFORCE_INSTITUTION_AID_LINK` | Yes | Yes | Backend/Node |
| `ENFORCE_JOHN_DRAFT_PLAUSIBILITY` | Yes | Yes | Backend/Node |
| `ENFORCE_LEAD_CONTACT_PLAUSIBILITY` | Yes | Yes | Backend/Node |
| `ENFORCE_LOCATOR_KIND_CLASSIFICATION` | Yes | Yes | Backend/Node |
| `ENFORCE_NON_GRANT_NOTICE_SCOPE` | Yes | Yes | Backend/Node |
| `ENFORCE_NON_GRANT_PIPELINE` | Yes | Yes | Backend/Node |
| `ENFORCE_NO_DANGLING_MATCHES` | Yes | Yes | Backend/Node |
| `ENFORCE_POINTER_TASK_RECLASS` | Yes | Yes | Backend/Node |
| `ENFORCE_PORTAL_SESSION_LIFETIME` | Yes | Yes | Backend/Node |
| `ENFORCE_PROFESSION_ELIGIBILITY` | Yes | Yes | Backend/Node |
| `ENFORCE_PROFILE_DISCOVERY_LINK` | Yes | Yes | Backend/Node |
| `ENFORCE_PROFILE_RESULT_FLOOR` | Yes | Yes | Backend/Node |
| `ENFORCE_PROFILE_SCOPED_PIPELINE` | Yes | Yes | Backend/Node |
| `ENFORCE_QUALIFIED_PROMOTION` | Yes | Yes | Backend/Node |
| `ENFORCE_RELEVANCE_FLOOR` | Yes | Yes | Backend/Node |
| `ENFORCE_SOURCE_URL_SELF_REPAIR` | Yes | Yes | Backend/Node |
| `ENFORCE_STAGE_OF_LIFE_SCOPE` | Yes | Yes | Backend/Node |
| `ENFORCE_STALE_MISSING_FIELDS` | Yes | Yes | Backend/Node |
| `ENFORCE_STATE_AGENCY_GEO_SCOPE` | Yes | Yes | Backend/Node |
| `ENFORCE_STATUS_PROVENANCE` | Yes | Yes | Backend/Node |
| `ENFORCE_STUDENT_AID_ELIGIBILITY` | Yes | Yes | Backend/Node |
| `ENFORCE_STUDENT_AID_INSTATE_LINK` | Yes | Yes | Backend/Node |
| `ENFORCE_SURFACED_MATCH_ELIGIBILITY` | Yes | Yes | Backend/Node |
| `ENFORCE_UNCONFIGURED_PROFILE_SCOPE` | Yes | Yes | Backend/Node |
| `ENFORCE_URL_HYGIENE` | Yes | Yes | Backend/Node |
| `ENFORCE_URL_RESCUE` | Yes | Yes | Backend/Node |
| `ENFORCE_VERIFIED_AT_HONESTY` | Yes | Yes | Backend/Node |
| `ENFORCE_XMATCH_PRECISION` | Yes | Yes | Backend/Node |
| `ERROR_REPORT_EMAIL` | Yes | Yes | Backend/Node |
| `EXPECTED_PATHS` | Yes | Yes | Backend/Node |
| `FEATURE_ANYA_TOOLS` | Yes | Yes | Backend/Node |
| `FEATURE_AUTO_REPAIR` | Yes | Yes | Backend/Node |
| `FEATURE_CRAWLER_RETRIES` | Yes | Yes | Backend/Node |
| `FEATURE_DETAILED_MATCHING` | Yes | Yes | Backend/Node |
| `FEATURE_GEO_CRAWL` | Yes | Yes | Backend/Node |
| `FIRST_LOGIN_REPORT_EMAIL` | Yes | Yes | Backend/Node |
| `FROM_EMAIL` | Yes | Yes | Backend/Node |
| `FRONTEND_BASE_URL` | Yes | Yes | Backend/Node |
| `FRONTEND_COMPONENTS_PATH` | Yes | Yes | Backend/Node |
| `FRONTEND_URL` | Yes | Yes | Backend/Node |
| `FUNDER_990_INGEST_LIMIT` | Yes | Yes | Backend/Node |
| `FUNDER_990_INGEST_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `FUNDER_990_MAX_ATTEMPTS` | Yes | Yes | Backend/Node |
| `FUNDER_990_MAX_TX` | Yes | Yes | Backend/Node |
| `FUNDING_APIS_REQUIRE_KEYS` | Yes | Yes | Backend/Node |
| `FUNDING_TRACE_MAX_AGE_YEARS` | Yes | Yes | Backend/Node |
| `FUNDING_TRACE_MIN_AMOUNT` | Yes | Yes | Backend/Node |
| `GAP_EMAIL_DRAFTS_ENABLED` | Yes | Yes | Backend/Node |
| `GEO_BATCH_SIZE` | Yes | Yes | Backend/Node |
| `GEO_COUNTIES_BY_STATE_PATH` | Yes | Yes | Backend/Node |
| `GEO_CRAWL_FIXTURES_DIR` | Yes | Yes | Backend/Node |
| `GEO_CRAWL_HEARTBEAT_MS` | Yes | Yes | Backend/Node |
| `GEO_MIN_SOURCES_PER_ZIP` | Yes | Yes | Backend/Node |
| `GEO_MIN_ZIP_COORDINATES` | Yes | Yes | Backend/Node |
| `GEO_RATE_LIMIT_MS` | Yes | Yes | Backend/Node |
| `GEO_RESUME_WINDOW_DAYS` | Yes | Yes | Backend/Node |
| `GEO_SCOPE` | Yes | Yes | Backend/Node |
| `GEO_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `GEO_ZIP_COORDINATES_PATH` | Yes | Yes | Backend/Node |
| `GF_ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `GF_ADMIN_PASSWORD` | Yes | Yes | Backend/Node |
| `GF_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `GF_API` | Yes | Yes | Backend/Node |
| `GF_CONFIRM_MUTATING_HOST` | Yes | Yes | Backend/Node |
| `GF_COUNTRIES` | Yes | Yes | Backend/Node |
| `GF_DEDUPE_STRATEGIES` | Yes | Yes | Backend/Node |
| `GF_GRANT_LIMIT` | Yes | Yes | Backend/Node |
| `GF_MAX_WAIT_MS` | Yes | Yes | Backend/Node |
| `GF_POLL_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `GF_TOKEN` | Yes | Yes | Backend/Node |
| `GITHUB_ACTIONS` | Yes | Yes | Backend/Node |
| `GITHUB_REPO` | Yes | Yes | Backend/Node |
| `GITHUB_TOKEN` | Yes | Yes | Backend/Node |
| `GIT_BRANCH` | Yes | Yes | Backend/Node |
| `GIT_COMMIT_SHA` | Yes | Yes | Backend/Node |
| `GMAIL_OAUTH_CLIENT_ID` | Yes | Yes | Backend/Node |
| `GMAIL_OAUTH_CLIENT_SECRET` | Yes | Yes | Backend/Node |
| `GMAIL_OAUTH_REFRESH_TOKEN` | Yes | Yes | Backend/Node |
| `GODADDY_API_KEY` | Yes | Yes | Backend/Node |
| `GODADDY_API_SECRET` | Yes | Yes | Backend/Node |
| `GODADDY_DOMAIN` | Yes | Yes | Backend/Node |
| `GOOGLE_API_KEY` | Yes | Yes | Backend/Node |
| `GOOGLE_BUDGET_ENABLED` | Yes | Yes | Backend/Node |
| `GOOGLE_CSE_CX` | Yes | Yes | Backend/Node |
| `GOOGLE_CSE_DAILY_BUDGET` | Yes | Yes | Backend/Node |
| `GOOGLE_CSE_KEY` | Yes | Yes | Backend/Node |
| `GOOGLE_SEARCH_CX` | Yes | Yes | Backend/Node |
| `GRANTFLOW_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS` | Yes | Yes | Backend/Node |
| `GRANTFLOW_API` | Yes | Yes | Backend/Node |
| `GRANTFLOW_API_BASE` | Yes | Yes | Backend/Node |
| `GRANTFLOW_APP_BASE_URL` | Yes | Yes | Backend/Node |
| `GRANTFLOW_AUDIT_EMAIL` | Yes | Yes | Backend/Node |
| `GRANTFLOW_AUDIT_PASSWORD` | Yes | Yes | Backend/Node |
| `GRANTFLOW_BASE_URL` | Yes | Yes | Backend/Node |
| `GRANTFLOW_BEARER_TOKEN` | Yes | Yes | Backend/Node |
| `GRANTFLOW_DISCOVERY_MIN_SCORE` | Yes | Yes | Backend/Node |
| `GRANTFLOW_DISCOVERY_MIN_SCORE_FLOOR` | Yes | Yes | Backend/Node |
| `GRANTFLOW_DRY_RUN` | Yes | Yes | Backend/Node |
| `GRANTFLOW_PROD_AUDIT_DATABASE_URL` | Yes | Yes | Backend/Node |
| `GRANTFLOW_PROD_BASE_URL` | Yes | Yes | Backend/Node |
| `GRANTFLOW_PROFILE_ID` | Yes | Yes | Backend/Node |
| `GRANTFLOW_PROFILE_IDS` | Yes | Yes | Backend/Node |
| `GRANTFLOW_REPO_ROOT` | Yes | Yes | Backend/Node |
| `GRANTFLOW_SCORING_MODEL` | Yes | Yes | Backend/Node |
| `GRANTFLOW_SEED_MODE` | Yes | Yes | Backend/Node |
| `GRANTFLOW_SIGNIN_URL` | Yes | Yes | Backend/Node |
| `GRANTFLOW_SKIP_MISSION_GATE` | Yes | Yes | Backend/Node |
| `GRANTFLOW_SKIP_VERIFICATION_GATE` | Yes | Yes | Backend/Node |
| `GRANTFLOW_TEST_EMAIL` | Yes | Yes | Backend/Node |
| `GRANTFLOW_TEST_PASSWORD` | Yes | Yes | Backend/Node |
| `GRANTFLOW_TEST_RUNNER` | Yes | Yes | Backend/Node |
| `GRANTFLOW_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `GRANTFLOW_TOKEN` | Yes | Yes | Backend/Node |
| `GRANTS_GOV_API_KEY` | Yes | Yes | Backend/Node |
| `GRANT_CATALOG_LINK_LIMIT` | Yes | Yes | Backend/Node |
| `GRANT_DIRECT_AMOUNT_BOOT_LIMIT` | Yes | Yes | Backend/Node |
| `GRANT_DIRECT_AMOUNT_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `GRANT_STRUCTURAL_RECLAIM_LIMIT` | Yes | Yes | Backend/Node |
| `HAMILTON_ADMIN_EMAIL` | Yes | Yes | Backend/Node |
| `HAMILTON_ADMIN_VAULT_PROFILE_ID` | Yes | Yes | Backend/Node |
| `HAMILTON_ALLOW_AUTOSUBMIT` | Yes | Yes | Backend/Node |
| `HAMILTON_AUTOPILOT_MAX_PAGES` | Yes | Yes | Backend/Node |
| `HAMILTON_AUTOPILOT_NAV_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `HAMILTON_AUTOPILOT_STEP_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST` | Yes | Yes | Backend/Node |
| `HAMILTON_BROWSER_STORAGE_DIR` | Yes | Yes | Backend/Node |
| `HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT` | Yes | Yes | Backend/Node |
| `HAMILTON_CLOUD_LOGIN_ENABLED` | Yes | Yes | Backend/Node |
| `HAMILTON_CLOUD_LOGIN_PROVIDER` | Yes | Yes | Backend/Node |
| `HAMILTON_CONFIRMATION_DIR` | Yes | Yes | Backend/Node |
| `HAMILTON_DECOMPOSE_POINTER_LISTINGS` | Yes | Yes | Backend/Node |
| `HAMILTON_ENABLE_BROWSER_AUTOMATION` | Yes | Yes | Backend/Node |
| `HAMILTON_LISTING_MAX_APPLIES` | Yes | Yes | Backend/Node |
| `HAMILTON_LISTING_MAX_ITEMS` | Yes | Yes | Backend/Node |
| `HAMILTON_PACKET_RETENTION_HOURS` | Yes | Yes | Backend/Node |
| `HAMILTON_PACKET_STORAGE_DIR` | Yes | Yes | Backend/Node |
| `HAMILTON_PORTAL_SYNC_MAX_PROMPTS` | Yes | Yes | Backend/Node |
| `HAMILTON_PORTAL_SYNC_STALE_DAYS` | Yes | Yes | Backend/Node |
| `HAMILTON_PROPOSAL_ANTHROPIC_MODEL` | Yes | Yes | Backend/Node |
| `HAMILTON_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `HAMILTON_SCHEDULE_BATCH_SIZE` | Yes | Yes | Backend/Node |
| `HAMILTON_SCHEDULE_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `HAMILTON_SCREENSHOTS_DIR` | Yes | Yes | Backend/Node |
| `HAMILTON_SCREENSHOT_RETENTION_HOURS` | Yes | Yes | Backend/Node |
| `HAMILTON_SELF_HEAL_REQUEUE_CAP` | Yes | Yes | Backend/Node |
| `HAMILTON_SESSION_KEEPALIVE_HOURS` | Yes | Yes | Backend/Node |
| `HAMILTON_SIGNUP_NAV_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `HAMILTON_SIGNUP_STEP_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `HAMILTON_SIGNUP_VERIFY_POLL_MS` | Yes | Yes | Backend/Node |
| `HAMILTON_SIGNUP_VERIFY_WAIT_MS` | Yes | Yes | Backend/Node |
| `HAMILTON_STOP_RECHECK_LIMIT` | Yes | Yes | Backend/Node |
| `HAMILTON_SUGGEST_MAX_RETRIES` | Yes | Yes | Backend/Node |
| `HAMILTON_SUGGEST_MODEL` | Yes | Yes | Backend/Node |
| `HAMILTON_SUGGEST_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `HAMILTON_SYNC_ON_CAPTURE` | Yes | Yes | Backend/Node |
| `HAMILTON_TAILORED_APPROVAL_GATE` | Yes | Yes | Backend/Node |
| `HAMILTON_VAULT_UNLOCK_TTL_MS` | Yes | Yes | Backend/Node |
| `HAMILTON_WEEKLY_DIGEST_DELIVERY` | Yes | Yes | Backend/Node |
| `HAMILTON_WEEKLY_DIGEST_ENABLED` | Yes | Yes | Backend/Node |
| `HAMILTON_WEEKLY_DIGEST_HOUR_ET` | Yes | Yes | Backend/Node |
| `HOSTNAME` | Yes | Yes | Backend/Node |
| `HOURS_LOOKBACK` | Yes | Yes | Backend/Node |
| `HTTP_KEEPALIVE_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `INDIVIDUAL_PIPELINE_AMOUNT_CEILING` | Yes | Yes | Backend/Node |
| `INGEST_CONNECTORS` | Yes | Yes | Backend/Node |
| `INSTITUTION_AID_LINK_LIMIT` | Yes | Yes | Backend/Node |
| `INSTITUTION_RUN_RECALL_CANDIDATES` | Yes | Yes | Backend/Node |
| `INSTITUTION_RUN_RECALL_LIMIT` | Yes | Yes | Backend/Node |
| `INTERNAL_API_URL` | Yes | Yes | Backend/Node |
| `INTERNAL_BASE_URL` | Yes | Yes | Backend/Node |
| `ITEM_NEED_MIN_SCORE` | Yes | Yes | Backend/Node |
| `ITEM_SEARCH_CATALOG_SCAN` | Yes | Yes | Backend/Node |
| `ITEM_SEARCH_MAX_ITEMS` | Yes | Yes | Backend/Node |
| `ITEM_SEARCH_MAX_RESULTS` | Yes | Yes | Backend/Node |
| `ITEM_SUGGESTIONS_PER_PROFILE` | Yes | Yes | Backend/Node |
| `ITEM_WEB_LEAD_MAX_RESULTS` | Yes | Yes | Backend/Node |
| `ITEM_WEB_LEAD_MIN_NEED_SCORE` | Yes | Yes | Backend/Node |
| `JOHN_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `JOHN_AI_DRAFTING` | Yes | Yes | Backend/Node |
| `JOHN_AI_MAX_RETRIES` | Yes | Yes | Backend/Node |
| `JOHN_AI_MODEL` | Yes | Yes | Backend/Node |
| `JOHN_AI_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `JOHN_ALLOW_PRIMARY_MAILBOX_FALLBACK_DRAFTS` | Yes | Yes | Backend/Node |
| `JOHN_ALLOW_SEND` | Yes | Yes | Backend/Node |
| `JOHN_DISPLAY_NAME` | Yes | Yes | Backend/Node |
| `JOHN_DRAFT_ONLY` | Yes | Yes | Backend/Node |
| `JOHN_DRAFT_PLAUSIBILITY_LIMIT` | Yes | Yes | Backend/Node |
| `JOHN_ENABLED` | Yes | Yes | Backend/Node |
| `JOHN_FROM_ALIAS` | Yes | Yes | Backend/Node |
| `JOHN_MAX_DRAFTS_PER_24H` | Yes | Yes | Backend/Node |
| `JOHN_MAX_DRAFTS_PER_HOUR` | Yes | Yes | Backend/Node |
| `JOHN_MAX_DRAFTS_PER_RUN` | Yes | Yes | Backend/Node |
| `JOHN_MAX_ENRICHMENT_DEFERRALS` | Yes | Yes | Backend/Node |
| `JOHN_MIN_LEAD_SCORE` | Yes | Yes | Backend/Node |
| `JOHN_MODE` | Yes | Yes | Backend/Node |
| `JOHN_OPT_OUT_LANGUAGE_REQUIRED` | Yes | Yes | Backend/Node |
| `JOHN_PHYSICAL_ADDRESS` | Yes | Yes | Backend/Node |
| `JOHN_PHYSICAL_ADDRESS_REQUIRED` | Yes | Yes | Backend/Node |
| `JOHN_PRIMARY_MAILBOX` | Yes | Yes | Backend/Node |
| `JOHN_PROSPECT_LINK` | Yes | Yes | Backend/Node |
| `JOHN_REPLY_TO` | Yes | Yes | Backend/Node |
| `JOHN_REQUIRE_ALIAS_REVIEW_IF_FALLBACK` | Yes | Yes | Backend/Node |
| `JOHN_REQUIRE_CONTACT_SOURCE` | Yes | Yes | Backend/Node |
| `JOHN_REQUIRE_HUMAN_REVIEW` | Yes | Yes | Backend/Node |
| `JOHN_REQUIRE_PUBLIC_EVIDENCE` | Yes | Yes | Backend/Node |
| `JOHN_REQUIRE_YANA_QUALIFIED` | Yes | Yes | Backend/Node |
| `JOHN_RUN_HEALTH_WINDOW_HOURS` | Yes | Yes | Backend/Node |
| `JOHN_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `JOHN_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `JOHN_SCHEDULE` | Yes | Yes | Backend/Node |
| `JOHN_SUPPRESSION_ENABLED` | Yes | Yes | Backend/Node |
| `JOHN_TEST_RECIPIENT` | Yes | Yes | Backend/Node |
| `JOHN_WEB_RESEARCH` | Yes | Yes | Backend/Node |
| `JWT_SECRET` | Yes | Yes | Backend/Node |
| `LAPTOP_CONNECTOR_API` | Yes | Yes | Backend/Node |
| `LAPTOP_CONNECTOR_MAX_RETRIES` | Yes | Yes | Backend/Node |
| `LAPTOP_CONNECTOR_MAX_TEXT` | Yes | Yes | Backend/Node |
| `LAPTOP_CONNECTOR_MODEL` | Yes | Yes | Backend/Node |
| `LAPTOP_CONNECTOR_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `LAPTOP_CONNECTOR_TOKEN` | Yes | Yes | Backend/Node |
| `LARRY_ENABLED` | Yes | Yes | Backend/Node |
| `LARRY_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `LARRY_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `LEAD_CONTACT_PLAUSIBILITY_LIMIT` | Yes | Yes | Backend/Node |
| `LEGACY_GRANT_ONLY_EXCLUDES_MATCHING` | Yes | Yes | Backend/Node |
| `LIMIT` | Yes | Yes | Backend/Node |
| `LIMIT_OPPS_PER_PROFILE` | Yes | Yes | Backend/Node |
| `LINK_VERIFICATION_BATCH` | Yes | Yes | Backend/Node |
| `LINK_VERIFICATION_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `LLM_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `LOCATOR_KIND_BOOT_LIMIT` | Yes | Yes | Backend/Node |
| `LOG_BUFFER_SIZE` | Yes | Yes | Backend/Node |
| `LOG_LEVEL` | Yes | Yes | Backend/Node |
| `MAINTENANCE_ESTIMATED_MINUTES` | Yes | Yes | Backend/Node |
| `MAINTENANCE_GRACE_MINUTES` | Yes | Yes | Backend/Node |
| `MAINTENANCE_STALE_BUFFER_MINUTES` | Yes | Yes | Backend/Node |
| `MAINTENANCE_STALE_HARD_MAX_MINUTES` | Yes | Yes | Backend/Node |
| `MAIN_DB_PATH` | Yes | Yes | Backend/Node |
| `MATCHING_ENGINE_FACET_DEBUG` | Yes | Yes | Backend/Node |
| `MATCH_SCOPE_PURGE_LIMIT` | Yes | Yes | Backend/Node |
| `MATCH_THRESHOLD` | Yes | Yes | Backend/Node |
| `MAX_CONCURRENT_CRAWLERS` | Yes | Yes | Backend/Node |
| `MAX_CRAWLER_RETRIES` | Yes | Yes | Backend/Node |
| `MAX_EXPORT_ROWS` | Yes | Yes | Backend/Node |
| `MAX_LIMIT` | Yes | Yes | Backend/Node |
| `MAX_ORPHAN_AUTO_RETRIES` | Yes | Yes | Backend/Node |
| `MAX_ORPHAN_RETRY_AGE_MS` | Yes | Yes | Backend/Node |
| `MAX_OWNED_PROFILES` | Yes | Yes | Backend/Node |
| `MAX_ZIPS` | Yes | Yes | Backend/Node |
| `MICROSOFT_CLIENT_ID` | Yes | Yes | Backend/Node |
| `MICROSOFT_CLIENT_SECRET` | Yes | Yes | Backend/Node |
| `MICROSOFT_GRAPH_SCOPES` | Yes | Yes | Backend/Node |
| `MICROSOFT_REDIRECT_URI` | Yes | Yes | Backend/Node |
| `MICROSOFT_TENANT_ID` | Yes | Yes | Backend/Node |
| `MIGRATE_ASSERT_FRESH` | Yes | Yes | Backend/Node |
| `MIGRATE_VERIFY_COUNTS` | Yes | Yes | Backend/Node |
| `MIN_NATIONAL_OPPORTUNITIES` | Yes | Yes | Backend/Node |
| `MIN_NATIONAL_VISIBLE` | Yes | Yes | Backend/Node |
| `MISSION_READINESS_CACHE_MS` | Yes | Yes | Backend/Node |
| `MODE` | Yes | No | Frontend (Vite) |
| `MONDAY_PORTAL_REMINDER_ENABLED` | Yes | Yes | Backend/Node |
| `MONDAY_PORTAL_REMINDER_HOUR_ET` | Yes | Yes | Backend/Node |
| `NAME` | Yes | Yes | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_ENABLED` | Yes | Yes | Backend/Node |
| `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES` | Yes | Yes | Backend/Node |
| `NATIONAL_PROGRAMS_JOB_WEDGE_MS` | Yes | Yes | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_DEPTH` | Yes | Yes | Backend/Node |
| `NATIONAL_PROGRAMS_MAX_URLS` | Yes | Yes | Backend/Node |
| `NEED_FIRST_RETAIN_UNANCHORED` | Yes | Yes | Backend/Node |
| `NIGHTLY_AMOUNT_ENRICH_LIMIT` | Yes | Yes | Backend/Node |
| `NIGHTLY_AMOUNT_ENRICH_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `NIGHTLY_MAINTENANCE_ENABLED` | Yes | Yes | Backend/Node |
| `NIGHTLY_MAINTENANCE_HOUR_ET` | Yes | Yes | Backend/Node |
| `NIGHTLY_MAINTENANCE_MINUTES` | Yes | Yes | Backend/Node |
| `NIGHTLY_MAINTENANCE_USE_WINDOW` | Yes | Yes | Backend/Node |
| `NIH_LIMIT` | Yes | Yes | Backend/Node |
| `NIH_TEXT` | Yes | Yes | Backend/Node |
| `NODE_ENV` | Yes | Yes | Backend/Node |
| `NOFO_FETCH_MAX_BYTES` | Yes | Yes | Backend/Node |
| `NOFO_FETCH_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `NOFO_PARSE_MAX_TEXT_CHARS` | Yes | Yes | Backend/Node |
| `NON_GRANT_PIPELINE_LIMIT` | Yes | Yes | Backend/Node |
| `OCR_PDF_DPI` | Yes | Yes | Backend/Node |
| `OCR_PDF_MAX_PAGES` | Yes | Yes | Backend/Node |
| `OCR_PROVIDER` | Yes | Yes | Backend/Node |
| `ONBOARDING_VERIFY_BASE` | Yes | Yes | Backend/Node |
| `OPENAI_API_KEY` | Yes | Yes | Backend/Node |
| `OPENAI_MAX_RETRIES` | Yes | Yes | Backend/Node |
| `OPENAI_MODEL` | Yes | Yes | Backend/Node |
| `OPENAI_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `OPPORTUNITY_INSERT_VERIFY_URL` | Yes | Yes | Backend/Node |
| `OPPORTUNITY_MIN_COUNT` | Yes | Yes | Backend/Node |
| `OPPORTUNITY_STALE_DAYS` | Yes | Yes | Backend/Node |
| `ORPHAN_MAINTENANCE_CONFIRM` | Yes | Yes | Backend/Node |
| `OWNER_ACCESS_TOKEN` | Yes | Yes | Backend/Node |
| `OWNER_ALIAS_EMAIL` | Yes | Yes | Backend/Node |
| `OWNER_CONTACT_EMAILS` | Yes | Yes | Backend/Node |
| `OWNER_EMAIL` | Yes | Yes | Backend/Node |
| `PGDATABASE` | Yes | Yes | Backend/Node |
| `PGHOST` | Yes | Yes | Backend/Node |
| `PGPASSWORD` | Yes | Yes | Backend/Node |
| `PGPORT` | Yes | Yes | Backend/Node |
| `PGSSLMODE` | Yes | Yes | Backend/Node |
| `PGUSER` | Yes | Yes | Backend/Node |
| `PG_POOL_CONN_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `PG_POOL_IDLE_MS` | Yes | Yes | Backend/Node |
| `PG_POOL_MAX` | Yes | Yes | Backend/Node |
| `PG_STATEMENT_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `PIPELINE_INSERT_RELEVANCE_FLOOR` | Yes | Yes | Backend/Node |
| `PIPELINE_JOB_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `PIPELINE_PROMOTION_HOUR_ET` | Yes | Yes | Backend/Node |
| `PIPELINE_PURGE_RELEVANCE_FLOOR` | Yes | Yes | Backend/Node |
| `PIPELINE_RELEVANCE_FLOOR` | Yes | Yes | Backend/Node |
| `PIPELINE_SLOW_MS` | Yes | Yes | Backend/Node |
| `PIPELINE_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `PIPELINE_TRUSTED_RELEVANCE_FLOOR` | Yes | Yes | Backend/Node |
| `POINTER_TASK_RECLASS_LIMIT` | Yes | Yes | Backend/Node |
| `POINTER_TASK_RECLASS_SCAN_LIMIT` | Yes | Yes | Backend/Node |
| `PORT` | Yes | Yes | Backend/Node |
| `PORTAL_SESSION_STAMP_LIMIT` | Yes | Yes | Backend/Node |
| `PORTAL_SYNC_LLM_EXTRACT` | Yes | Yes | Backend/Node |
| `PORTAL_SYNC_REQUEST_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `PORTAL_WALL_REPROBE_MS` | Yes | Yes | Backend/Node |
| `POSTGRES_DB` | Yes | Yes | Backend/Node |
| `POSTGRES_HOST` | Yes | Yes | Backend/Node |
| `POSTGRES_PASSWORD` | Yes | Yes | Backend/Node |
| `POSTGRES_PORT` | Yes | Yes | Backend/Node |
| `POSTGRES_USER` | Yes | Yes | Backend/Node |
| `PREVIEW_PORT` | Yes | Yes | Backend/Node |
| `PRICING_ADMIN_NOTIFICATION_EMAIL` | Yes | Yes | Backend/Node |
| `PRICING_ADMIN_TOASTS_ENABLED` | Yes | Yes | Backend/Node |
| `PRICING_ALLOW_LIMITED_MATCH_PREVIEW_BEFORE_PAYMENT` | Yes | Yes | Backend/Node |
| `PRICING_AUTO_DISCOUNTS_ENABLED` | Yes | Yes | Backend/Node |
| `PRICING_AUTO_INITIALIZE_ON_PROFILE_CREATE` | Yes | Yes | Backend/Node |
| `PRICING_DISCOUNTS_ENABLED` | Yes | Yes | Backend/Node |
| `PRICING_MAX_TOTAL_DISCOUNT_PERCENT` | Yes | Yes | Backend/Node |
| `PRICING_REQUIRE_ADMIN_APPROVAL` | Yes | Yes | Backend/Node |
| `PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS` | Yes | Yes | Backend/Node |
| `PRICING_REQUIRE_PAYMENT_BEFORE_FULL_ACCESS` | Yes | Yes | Backend/Node |
| `PRICING_SHOW_CLIENT_ESTIMATE` | Yes | Yes | Backend/Node |
| `PRICING_SHOW_DISCOUNT_ELIGIBILITY_TO_CLIENT` | Yes | Yes | Backend/Node |
| `PROBE_BASE_URL` | Yes | Yes | Backend/Node |
| `PROD` | Yes | No | Frontend (Vite) |
| `PROFILE_DISCOVERY_LINK_LIMIT` | Yes | Yes | Backend/Node |
| `PROFILE_DOCS_ADMIN_USER_ID` | Yes | Yes | Backend/Node |
| `PROFILE_DOCS_CONFIRM` | Yes | Yes | Backend/Node |
| `PROFILE_DOCS_CONFIRM_DB_PATH` | Yes | Yes | Backend/Node |
| `PROFILE_DOCS_DB_PATH` | Yes | Yes | Backend/Node |
| `PROFILE_DOCS_SOURCE_DIR` | Yes | Yes | Backend/Node |
| `PROFILE_DOCS_UPLOADS_DIR` | Yes | Yes | Backend/Node |
| `PROFILE_GATE_TRUST_ENGINE` | Yes | Yes | Backend/Node |
| `PROFILE_ID` | Yes | Yes | Backend/Node |
| `PROFILE_RESULT_TARGET` | Yes | Yes | Backend/Node |
| `PROFILE_SCOPE_CI_STRICT` | Yes | Yes | Backend/Node |
| `PROFILE_SCOPE_FUNDING_READS` | Yes | Yes | Backend/Node |
| `PROFILE_SCOPE_MODE` | Yes | Yes | Backend/Node |
| `PROFILE_SCOPE_STRICT` | Yes | Yes | Backend/Node |
| `PROFILE_TAXONOMY_DEBUG` | Yes | Yes | Backend/Node |
| `PROMOTION_AMOUNT_BUDGET` | Yes | Yes | Backend/Node |
| `PROMOTION_AMOUNT_GRACE_DAYS` | Yes | Yes | Backend/Node |
| `PROMOTION_BATCH` | Yes | Yes | Backend/Node |
| `PROMOTION_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `PROPOSAL_CRITIC` | Yes | Yes | Backend/Node |
| `PUBLIC_APP_URL` | Yes | Yes | Backend/Node |
| `PUBLIC_URL` | Yes | Yes | Backend/Node |
| `QUEUE_DRAIN_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `QUEUE_POLL_ENABLED` | Yes | Yes | Backend/Node |
| `QUEUE_POLL_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `QUEUE_STAGGER_DELAY_MS` | Yes | Yes | Backend/Node |
| `QUEUE_STARTUP_DELAY_MS` | Yes | Yes | Backend/Node |
| `RAILWAY_DEPLOYMENT_ID` | Yes | Yes | Backend/Node |
| `RAILWAY_DEPLOYMENT_START_TIME` | Yes | Yes | Backend/Node |
| `RAILWAY_ENVIRONMENT` | Yes | Yes | Backend/Node |
| `RAILWAY_ENVIRONMENT_ID` | Yes | Yes | Backend/Node |
| `RAILWAY_GIT_BRANCH` | Yes | Yes | Backend/Node |
| `RAILWAY_GIT_COMMIT_SHA` | Yes | Yes | Backend/Node |
| `RAILWAY_PROJECT_ID` | Yes | Yes | Backend/Node |
| `RAILWAY_SERVICE_ID` | Yes | Yes | Backend/Node |
| `RAILWAY_STATIC_URL` | Yes | Yes | Backend/Node |
| `RAILWAY_VOLUME_MOUNT_PATH` | Yes | Yes | Backend/Node |
| `REATTACH_ADMIN_USER_ID` | Yes | Yes | Backend/Node |
| `REATTACH_CONFIRM` | Yes | Yes | Backend/Node |
| `REATTACH_CONFIRM_DB_PATH` | Yes | Yes | Backend/Node |
| `REATTACH_DB_PATH` | Yes | Yes | Backend/Node |
| `REATTACH_SUMMARY_PATH` | Yes | Yes | Backend/Node |
| `REGISTRY_VERIFICATION_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `REPO_REWARDS_URL` | Yes | Yes | Backend/Node |
| `REQUEST_ID_ERROR_STORE_MAX` | Yes | Yes | Backend/Node |
| `REQUEST_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `RESEND_API_KEY` | Yes | Yes | Backend/Node |
| `RESULT_FLOOR_PROFILE_LIMIT` | Yes | Yes | Backend/Node |
| `ROBERT_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `ROBERT_ALLOW_LIVE_WEB` | Yes | Yes | Backend/Node |
| `ROBERT_ALLOW_REVIEW_MATCH_TOASTS` | Yes | Yes | Backend/Node |
| `ROBERT_ALLOW_SEARCH_ENGINE` | Yes | Yes | Backend/Node |
| `ROBERT_ALLOW_SOURCE_DISCOVERY` | Yes | Yes | Backend/Node |
| `ROBERT_AUTOSEED_MAX_ENTITIES` | Yes | Yes | Backend/Node |
| `ROBERT_AUTOSEED_MAX_PROFILES` | Yes | Yes | Backend/Node |
| `ROBERT_AUTOSEED_MIN_RISK` | Yes | Yes | Backend/Node |
| `ROBERT_AUTOSEED_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `ROBERT_AUTOSEED_SCHEDULE` | Yes | Yes | Backend/Node |
| `ROBERT_AUTO_INGEST_VERIFIED` | Yes | Yes | Backend/Node |
| `ROBERT_BATCH_LOW_PRIORITY_RECOMMENDATIONS` | Yes | Yes | Backend/Node |
| `ROBERT_CONTACTS_MAILBOX` | Yes | Yes | Backend/Node |
| `ROBERT_CONTACT_HARVEST` | Yes | Yes | Backend/Node |
| `ROBERT_ENABLED` | Yes | Yes | Backend/Node |
| `ROBERT_FAIL_OPEN` | Yes | Yes | Backend/Node |
| `ROBERT_GMAIL_ACCOUNT` | Yes | Yes | Backend/Node |
| `ROBERT_GMAIL_APP_PASSWORD` | Yes | Yes | Backend/Node |
| `ROBERT_GRAPH_ACCOUNT` | Yes | Yes | Backend/Node |
| `ROBERT_HARVEST_DAYS` | Yes | Yes | Backend/Node |
| `ROBERT_HARVEST_MAX_CONTACTS` | Yes | Yes | Backend/Node |
| `ROBERT_HARVEST_MAX_MESSAGES` | Yes | Yes | Backend/Node |
| `ROBERT_JOHN_DEFAULT_LEAD_SCORE` | Yes | Yes | Backend/Node |
| `ROBERT_JOHN_MAX_LEADS_PER_24H` | Yes | Yes | Backend/Node |
| `ROBERT_MAX_OPPORTUNITIES_PER_RUN` | Yes | Yes | Backend/Node |
| `ROBERT_MAX_PROFILES_PER_RUN` | Yes | Yes | Backend/Node |
| `ROBERT_MAX_SOURCES_PER_RUN` | Yes | Yes | Backend/Node |
| `ROBERT_MAX_TOASTS_PER_PROFILE_PER_DAY` | Yes | Yes | Backend/Node |
| `ROBERT_MAX_URLS_PER_SOURCE` | Yes | Yes | Backend/Node |
| `ROBERT_MESSAGE_SCAN_MAX` | Yes | Yes | Backend/Node |
| `ROBERT_MIN_SOURCE_TRUST` | Yes | Yes | Backend/Node |
| `ROBERT_MIN_TOAST_MATCH_SCORE` | Yes | Yes | Backend/Node |
| `ROBERT_MODE` | Yes | Yes | Backend/Node |
| `ROBERT_PERSIST_CANDIDATES` | Yes | Yes | Backend/Node |
| `ROBERT_RATE_LIMIT_PER_DOMAIN_PER_HOUR` | Yes | Yes | Backend/Node |
| `ROBERT_RECOMMENDATION_LIVE_STREAM_ENABLED` | Yes | Yes | Backend/Node |
| `ROBERT_RECOMMENDATION_POLL_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `ROBERT_RECOMMENDATION_QUEUE_ON_LOGIN` | Yes | Yes | Backend/Node |
| `ROBERT_RECOMMENDATION_TOASTS_ENABLED` | Yes | Yes | Backend/Node |
| `ROBERT_REQUIRE_REAL_APPLICATION_URL` | Yes | Yes | Backend/Node |
| `ROBERT_RESPECT_ROBOTS` | Yes | Yes | Backend/Node |
| `ROBERT_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `ROBERT_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `ROBERT_SCAN_EMAIL_CONTACTS` | Yes | Yes | Backend/Node |
| `ROBERT_SCAN_EMAIL_MESSAGES` | Yes | Yes | Backend/Node |
| `ROBERT_SCHEDULE` | Yes | Yes | Backend/Node |
| `ROBERT_SCHEDULED_MODE` | Yes | Yes | Backend/Node |
| `ROBERT_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `ROBERT_USER_AGENT` | Yes | Yes | Backend/Node |
| `ROBERT_YAHOO_PRIMARY_ACCOUNT` | Yes | Yes | Backend/Node |
| `ROBERT_YAHOO_PRIMARY_APP_PASSWORD` | Yes | Yes | Backend/Node |
| `ROBERT_YAHOO_SECONDARY_ACCOUNT` | Yes | Yes | Backend/Node |
| `ROBERT_YAHOO_SECONDARY_APP_PASSWORD` | Yes | Yes | Backend/Node |
| `RUNTIME_SECRETS_KEY` | Yes | Yes | Backend/Node |
| `RUN_GEO_CRAWL` | Yes | Yes | Backend/Node |
| `RUN_ITEM_CRAWLERS` | Yes | Yes | Backend/Node |
| `RUN_SQLITE_MIGRATION` | Yes | Yes | Backend/Node |
| `SAM_ADVERSARIAL_MAX_REPAIRS` | Yes | Yes | Backend/Node |
| `SAM_ALLOW_SAFE_REPAIR` | Yes | Yes | Backend/Node |
| `SAM_AUTO_FIX_SAFE` | Yes | Yes | Backend/Node |
| `SAM_CHECK_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `SAM_DAILY_CODE_SWEEP_ENABLED` | Yes | Yes | Backend/Node |
| `SAM_DAILY_CODE_SWEEP_HOUR_ET` | Yes | Yes | Backend/Node |
| `SAM_EMAIL_REPORTS` | Yes | Yes | Backend/Node |
| `SAM_ENABLED` | Yes | Yes | Backend/Node |
| `SAM_FAIL_ON_CRITICAL` | Yes | Yes | Backend/Node |
| `SAM_GOV_API_BASE_URL` | Yes | Yes | Backend/Node |
| `SAM_GOV_API_KEY` | Yes | Yes | Backend/Node |
| `SAM_GOV_KEY` | Yes | Yes | Backend/Node |
| `SAM_GOV_PUBLIC_API_KEY` | Yes | Yes | Backend/Node |
| `SAM_HTTP_PROBE_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `SAM_MAX_FIXES_PER_RUN` | Yes | Yes | Backend/Node |
| `SAM_MODE` | Yes | Yes | Backend/Node |
| `SAM_REPORT_EMAIL` | Yes | Yes | Backend/Node |
| `SAM_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `SAM_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `SAM_SCHEDULE` | Yes | Yes | Backend/Node |
| `SAM_SCHEDULE_AUTOFIX` | Yes | Yes | Backend/Node |
| `SCHOOL_PORTAL_VERIFY_BASE` | Yes | Yes | Backend/Node |
| `SCORE_BACKFILL_BATCH` | Yes | Yes | Backend/Node |
| `SEARXNG_ENGINES` | Yes | Yes | Backend/Node |
| `SEARXNG_FALLBACK_ENGINES` | Yes | Yes | Backend/Node |
| `SEARXNG_MIN_INTERVAL_MS` | Yes | Yes | Backend/Node |
| `SEARXNG_URL` | Yes | Yes | Backend/Node |
| `SEED_KEY` | Yes | Yes | Backend/Node |
| `SEED_PATH` | Yes | Yes | Backend/Node |
| `SEMANTIC_RECALL` | Yes | Yes | Backend/Node |
| `SEMANTIC_RECALL_SCAN_LIMIT` | Yes | Yes | Backend/Node |
| `SEMANTIC_RECALL_TOP_K` | Yes | Yes | Backend/Node |
| `SENDGRID_API_KEY` | Yes | Yes | Backend/Node |
| `SENTRY_DSN` | Yes | Yes | Backend/Node |
| `SENTRY_ENVIRONMENT` | Yes | Yes | Backend/Node |
| `SENTRY_RELEASE` | Yes | Yes | Backend/Node |
| `SENTRY_TRACES_SAMPLE_RATE` | Yes | Yes | Backend/Node |
| `SERVICE_APPLICATION_EMAIL` | Yes | Yes | Backend/Node |
| `SERVICE_CATALOG_SEED_TTL_MS` | Yes | Yes | Backend/Node |
| `SHOULDERS_VNEXT` | Yes | Yes | Backend/Node |
| `SHUTDOWN_GRACE_MS` | Yes | Yes | Backend/Node |
| `SIMPLER_GRANTS_API_KEY` | Yes | Yes | Backend/Node |
| `SKIP_NETWORK_TESTS` | Yes | Yes | Backend/Node |
| `SMART_MATCHER_INTENT_MODEL` | Yes | Yes | Backend/Node |
| `SMOKE_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `SMOKE_API_BASE` | Yes | Yes | Backend/Node |
| `SMOKE_BASE_PATH` | Yes | Yes | Backend/Node |
| `SMOKE_BASE_URL` | Yes | Yes | Backend/Node |
| `SMOKE_CHECK_PROFILE_SCHEMA` | Yes | Yes | Backend/Node |
| `SMOKE_DEBUG` | Yes | Yes | Backend/Node |
| `SMOKE_MAX_CLICKS` | Yes | Yes | Backend/Node |
| `SMOKE_MAX_PER_SELECTOR` | Yes | Yes | Backend/Node |
| `SMOKE_MAX_ROUTES` | Yes | Yes | Backend/Node |
| `SMOKE_MODE` | Yes | Yes | Backend/Node |
| `SMOKE_TARGET_PATH` | Yes | Yes | Backend/Node |
| `SMS_CONSENT_MESSAGE` | Yes | Yes | Backend/Node |
| `SMS_CONSENT_PENDING_EXPIRE_DAYS` | Yes | Yes | Backend/Node |
| `SMTP_HOST` | Yes | Yes | Backend/Node |
| `SOURCE` | Yes | Yes | Backend/Node |
| `SOURCE_URL_REPAIR_BOOT_LIMIT` | Yes | Yes | Backend/Node |
| `SOURCE_URL_REPAIR_COOLDOWN_MS` | Yes | Yes | Backend/Node |
| `SOURCE_URL_REPAIR_MAX_ATTEMPTS` | Yes | Yes | Backend/Node |
| `SOURCE_URL_REPAIR_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `SQLITE_BUSY_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `SQLITE_CACHE_SIZE_KB` | Yes | Yes | Backend/Node |
| `SQLITE_DB_PATH` | Yes | Yes | Backend/Node |
| `SQLITE_PATH` | Yes | Yes | Backend/Node |
| `STALE_MISSING_FIELD_PROFILE_LIMIT` | Yes | Yes | Backend/Node |
| `STARTUP_PROFILE_JOB_REPAIR_LIMIT` | Yes | Yes | Backend/Node |
| `STARTUP_PROFILE_ORG_LINK_LIMIT` | Yes | Yes | Backend/Node |
| `STARTUP_SMOKE_CRAWL_ENABLED` | Yes | Yes | Backend/Node |
| `STRIPE_MOCK` | Yes | Yes | Backend/Node |
| `STRIPE_SECRET_KEY` | Yes | Yes | Backend/Node |
| `STRIPE_WEBHOOK_SECRET` | Yes | Yes | Backend/Node |
| `SWEEP_DEBUG` | Yes | Yes | Backend/Node |
| `Sam_gov_key` | Yes | Yes | Backend/Node |
| `TEST_API_URL` | Yes | Yes | Backend/Node |
| `TEST_CONCURRENCY` | Yes | Yes | Backend/Node |
| `TEST_STATE` | Yes | Yes | Backend/Node |
| `TEST_ZIP` | Yes | Yes | Backend/Node |
| `TWILIO_ACCOUNT_SID` | Yes | Yes | Backend/Node |
| `TWILIO_AUTH_TOKEN` | Yes | Yes | Backend/Node |
| `TWILIO_FROM_NUMBER` | Yes | Yes | Backend/Node |
| `TWILIO_MESSAGING_SERVICE_SID` | Yes | Yes | Backend/Node |
| `UNCONFIGURED_PROFILE_PURGE_LIMIT` | Yes | Yes | Backend/Node |
| `UNIT_TEST_CONCURRENCY` | Yes | Yes | Backend/Node |
| `UNIT_TEST_HARD_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `UPLOADS_DIR` | Yes | Yes | Backend/Node |
| `UPLOADS_ORPHAN_GRACE_HOURS` | Yes | Yes | Backend/Node |
| `UPLOADS_ORPHAN_PRUNE_ENABLED` | Yes | Yes | Backend/Node |
| `UPLOADS_PERSIST_PREFIXES` | Yes | Yes | Backend/Node |
| `UPLOAD_DIR` | Yes | Yes | Backend/Node |
| `URL_RESCUE_BOOT_LIMIT` | Yes | Yes | Backend/Node |
| `URL_RESCUE_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `URL_VERIFICATION_ENABLED` | Yes | Yes | Backend/Node |
| `USER_PROFILE_MAPPINGS_FILE` | Yes | Yes | Backend/Node |
| `USER_PROFILE_MAPPINGS_JSON` | Yes | Yes | Backend/Node |
| `VEHICLES_INGEST_TOKEN` | Yes | Yes | Backend/Node |
| `VERCEL` | Yes | Yes | Backend/Node |
| `VERCEL_ENV` | Yes | Yes | Backend/Node |
| `VERCEL_GIT_COMMIT_SHA` | Yes | Yes | Used in both backend + frontend |
| `VERIFICATION_CACHE_MAX_ENTRIES` | Yes | Yes | Backend/Node |
| `VERIFICATION_CACHE_TTL_MS` | Yes | Yes | Backend/Node |
| `VERIFIED_AT_HONESTY_BOOT_LIMIT` | Yes | Yes | Backend/Node |
| `VERIFIED_AT_HONESTY_TIME_BUDGET_MS` | Yes | Yes | Backend/Node |
| `VERIFY_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `VERIFY_BACKEND_BASE_URL` | Yes | Yes | Backend/Node |
| `VERIFY_BASE_URL` | Yes | Yes | Backend/Node |
| `VERIFY_DB_PATH` | Yes | Yes | Backend/Node |
| `VERIFY_GEO_RUN_ID` | Yes | Yes | Backend/Node |
| `VERIFY_PROFILE_ID` | Yes | Yes | Backend/Node |
| `VERIFY_REATTACH_ADMIN_USER_ID` | Yes | Yes | Backend/Node |
| `VERIFY_REATTACH_DB_PATH` | Yes | Yes | Backend/Node |
| `VERIFY_REATTACH_OUTPUT_PATH` | Yes | Yes | Backend/Node |
| `VERIFY_UI_BASE_URL` | Yes | Yes | Backend/Node |
| `VERIFY_UI_OUT_DIR` | Yes | Yes | Backend/Node |
| `VITEST` | Yes | Yes | Backend/Node |
| `VITE_ANYA_COPILOT_ENABLED` | Yes | Yes | Frontend (Vite) |
| `VITE_ANYA_SCREENSHOT_ENABLED` | Yes | Yes | Frontend (Vite) |
| `VITE_API_URL` | Yes | Yes | Frontend (Vite) |
| `VITE_APP_BASE` | Yes | Yes | Used in both backend + frontend |
| `VITE_ASSET_BASE` | Yes | Yes | Backend/Node |
| `VITE_CANONICAL_HOST` | Yes | Yes | Frontend (Vite) |
| `VITE_CANONICAL_HOST_STRICT` | Yes | Yes | Frontend (Vite) |
| `VITE_DEV_ADMIN_TOKEN` | Yes | Yes | Frontend (Vite) |
| `VITE_ENABLE_CLICK_TRACER` | Yes | Yes | Frontend (Vite) |
| `VITE_ENABLE_CLIENT_LOGS` | Yes | Yes | Frontend (Vite) |
| `VITE_FORCE_RAILWAY_API` | Yes | Yes | Frontend (Vite) |
| `VITE_PREVIEW_API_URL` | Yes | Yes | Frontend (Vite) |
| `VITE_SENTRY_DSN` | Yes | Yes | Frontend (Vite) |
| `VITE_SENTRY_ENVIRONMENT` | Yes | Yes | Frontend (Vite) |
| `VITE_SENTRY_RELEASE` | Yes | Yes | Frontend (Vite) |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | Yes | Yes | Frontend (Vite) |
| `VITE_SHOULDERS_VNEXT` | Yes | Yes | Frontend (Vite) |
| `VITE_SMOKE_MODE` | Yes | Yes | Backend/Node |
| `VITE_SUPPORT_EMAIL` | Yes | Yes | Frontend (Vite) |
| `VITE_SUPPORT_FAX` | Yes | Yes | Frontend (Vite) |
| `WARM_COUNTY_CACHE` | Yes | Yes | Backend/Node |
| `WEB_DISCOVERY_ENABLED` | Yes | Yes | Backend/Node |
| `WEB_DISCOVERY_MODEL_ANTHROPIC` | Yes | Yes | Backend/Node |
| `WEB_DISCOVERY_MODEL_OPENAI` | Yes | Yes | Backend/Node |
| `WEB_LANE_MAX_PAGES` | Yes | Yes | Backend/Node |
| `WEB_LANE_MAX_QUERIES` | Yes | Yes | Backend/Node |
| `WEB_LANE_PROFILE_BLIND` | Yes | Yes | Backend/Node |
| `WEB_LANE_PROFILE_BLIND_MAX_PAGES` | Yes | Yes | Backend/Node |
| `WEB_LANE_PROFILE_BLIND_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `WEB_LANE_PROFILE_BLIND_TOTAL_BUDGET_MS` | Yes | Yes | Backend/Node |
| `WEB_LANE_RESULTS_PER_QUERY` | Yes | Yes | Backend/Node |
| `WEB_LANE_TARGET_VERIFY_BUDGET_MS` | Yes | Yes | Backend/Node |
| `WEB_LANE_TARGET_VERIFY_MAX` | Yes | Yes | Backend/Node |
| `WEB_LANE_TARGET_VERIFY_TIMEOUT_MS` | Yes | Yes | Backend/Node |
| `WEB_PARITY_BENCHMARK` | Yes | Yes | Backend/Node |
| `WEB_SEARCH_CACHE_TTL_HOURS` | Yes | Yes | Backend/Node |
| `WEEKLY_VERIFY_CHUNKS` | Yes | Yes | Backend/Node |
| `X_ADMIN_TOKEN` | Yes | Yes | Backend/Node |
| `YANA_ALLOW_LIVE_WEB` | Yes | Yes | Backend/Node |
| `YANA_BACKLOG_ENRICH_LIMIT` | Yes | Yes | Backend/Node |
| `YANA_BACKLOG_ENRICH_MAX_ATTEMPTS` | Yes | Yes | Backend/Node |
| `YANA_CAP_WINDOW_HOURS` | Yes | Yes | Backend/Node |
| `YANA_DAILY_LEAD_CAP` | Yes | Yes | Backend/Node |
| `YANA_ENABLED` | Yes | Yes | Backend/Node |
| `YANA_ENRICH_CONCURRENCY` | Yes | Yes | Backend/Node |
| `YANA_EXCLUDED_DOMAINS` | Yes | Yes | Backend/Node |
| `YANA_HARVEST_VERIFY_LIMIT` | Yes | Yes | Backend/Node |
| `YANA_LEADS_ENABLED` | Yes | Yes | Backend/Node |
| `YANA_LEADS_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `YANA_LEADS_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `YANA_OSM_USER_AGENT` | Yes | Yes | Backend/Node |
| `YANA_QUALIFY_THRESHOLD` | Yes | Yes | Backend/Node |
| `YANA_RESEARCH_STATES` | Yes | Yes | Backend/Node |
| `YANA_RUN_ON_SCHEDULE` | Yes | Yes | Backend/Node |
| `YANA_RUN_ON_STARTUP` | Yes | Yes | Backend/Node |
| `YANA_TARGET_AREAS` | Yes | Yes | Backend/Node |
| `YANA_WEB_CSV_FEED_URL` | Yes | Yes | Backend/Node |
| `YANA_WEB_JSON_FEED_URL` | Yes | Yes | Backend/Node |
| `ZIP_COUNTY_MAP_PATH` | Yes | Yes | Backend/Node |
| `npm_package_version` | Yes | Yes | Backend/Node |

## Usage locations (file + line ranges)

### `ACCESS_TOKEN`

- **Templates**:
  - `.env.example:40` = `<REPLACE_ME>`
  - `backend/.env.example:9` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L26` (process.env)

### `ADMIN_EMAIL`

- **Templates**:
  - `.env.example:41` = `admin@example.invalid`
  - `backend/.env.example:10` = `admin@example.invalid`
- **Code references**:
  - `backend/config/constants.js:L15` (process.env)
  - `backend/scripts/seed-deterministic.mjs:L50` (process.env)
  - `backend/server.js:L206` (process.env)
  - `backend/services/agentControl/agentAdapters/samAgentAdapter.js:L37` (process.env)
  - `backend/services/agentControl/agentControlOrchestrator.js:L174` (process.env)
  - `backend/services/email.js:L329` (process.env)
  - `backend/services/sam/samAgent.js:L605` (process.env)
  - `backend/tests/samCanonicalAdminEmail.test.js:L32–L87` (process.env)
  - `scripts/ensure-admin-user.mjs:L19` (process.env)
  - `tests/e2e/playwright.config.mjs:L12` (process.env)

### `ADMIN_EMAILS`

- **Templates**:
  - `.env.example:42` = ``
  - `backend/.env.example:11` = ``
- **Code references**:
  - `backend/config/constants.js:L23` (process.env)

### `ADMIN_HEALTH_TOKEN`

- **Templates**:
  - `.env.example:43` = `<REPLACE_ME>`
  - `backend/.env.example:12` = `<REPLACE_ME>`
- **Code references**:
  - `backend/middleware/authIdentity.js:L57` (process.env)
  - `backend/services/codeGuardService.js:L82` (process.env)

### `ADMIN_LOGIN_EVENT_BUFFER`

- **Templates**:
  - `.env.example:44` = ``
  - `backend/.env.example:13` = ``
- **Code references**:
  - `backend/services/adminLoginEventStore.js:L6` (process.env)

### `ADMIN_NAME`

- **Templates**:
  - `.env.example:45` = `Admin User`
  - `backend/.env.example:14` = `Admin User`
- **Code references**:
  - `backend/scripts/seed-deterministic.mjs:L51` (process.env)
  - `backend/server.js:L188` (process.env)
  - `scripts/ensure-admin-user.mjs:L21` (process.env)
  - `tests/e2e/playwright.config.mjs:L36` (process.env)

### `ADMIN_OPS_EMAIL`

- **Templates**:
  - `.env.example:46` = ``
  - `backend/.env.example:15` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L604` (process.env)

### `ADMIN_PHONE`

- **Templates**:
  - `.env.example:47` = ``
  - `backend/.env.example:16` = ``
- **Code references**:
  - `scripts/ensure-admin-user.mjs:L20` (process.env)

### `ADMIN_RUN_SOURCE_BUDGET_MS`

- **Templates**:
  - `.env.example:48` = ``
  - `backend/.env.example:17` = ``
- **Code references**:
  - `backend/routes/adminCrawlCoverageActions.js:L49` (process.env)
  - `backend/tests/adminCrawlCoverageActions.test.js:L32` (process.env)

### `ADMIN_SELF_BASE_URL`

- **Templates**:
  - `.env.example:49` = `http://127.0.0.1:8080`
  - `backend/.env.example:18` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/anyaAdminTools.js:L1330` (process.env)

### `ADMIN_TOKEN`

- **Templates**:
  - `.env.example:50` = `<REPLACE_ME>`
  - `backend/.env.example:19` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/anya.js:L26` (process.env)
  - `backend/routes/authMe.js:L287` (process.env)
  - `backend/routes/blocklist.js:L35` (process.env)
  - `backend/routes/emailGrants.js:L31` (process.env)
  - `backend/routes/john.js:L71` (process.env)
  - `backend/routes/robert.js:L63` (process.env)
  - `backend/routes/sam.js:L180` (process.env)
  - `backend/routes/vehicles.js:L37` (process.env)
  - `backend/scripts/check-crawler-results.mjs:L25` (process.env)
  - `backend/server.js:L187–L1908` (process.env)
  - `backend/services/anyaAdminTools.js:L1367` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L220` (process.env)
  - `backend/services/anyaStartupAudit.js:L42` (process.env)
  - `backend/services/anyaToolRegistry.js:L4240–L4419` (process.env)
  - `backend/services/codeGuardService.js:L83` (process.env)
  - `backend/services/sam/samHttpProbe.js:L54` (process.env)
  - `backend/tests/samHttpProbe.test.js:L9–L15` (process.env)
  - `backend/tests/testServer.js:L18` (process.env)
  - `scripts/_lib/secrets.mjs:L21` (process.env)
  - `scripts/admin-dedupe-all-profiles.mjs:L17` (process.env)
  - `scripts/dedupe-profiles.mjs:L29` (process.env)
  - `scripts/doctor.mjs:L79` (process.env)
  - `scripts/hamilton-import-chrome-csv.mjs:L33` (process.env)
  - `scripts/hamilton-route-chrome-csv.mjs:L48` (process.env)
  - `scripts/run-all-real-crawlers.mjs:L6` (process.env)
  - `scripts/runtime-crawl-local.mjs:L128` (process.env)
  - `scripts/scratch-scholarships-diag.mjs:L4` (process.env)
  - `scripts/smoke-auth-diagnostics.mjs:L13` (process.env)
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

### `ADVERSARIAL_AUTHOR_MAX_TOKENS`

- **Templates**:
  - `.env.example:51` = ``
  - `backend/.env.example:20` = ``
- **Code references**:
  - `backend/services/anyaAdversarialRepairLoop.js:L300` (process.env)

### `ADVERSARIAL_AUTHOR_MODEL`

- **Templates**:
  - `.env.example:52` = ``
  - `backend/.env.example:21` = ``
- **Code references**:
  - `backend/services/anyaAdversarialRepairLoop.js:L294` (process.env)

### `ADVERSARIAL_GATE_POLL_INTERVAL_MS`

- **Templates**:
  - `.env.example:53` = ``
  - `backend/.env.example:22` = ``
- **Code references**:
  - `backend/services/anyaCodeFixDispatch.js:L359` (process.env)

### `ADVERSARIAL_GATE_POLL_TIMEOUT_MS`

- **Templates**:
  - `.env.example:54` = ``
  - `backend/.env.example:23` = ``
- **Code references**:
  - `backend/services/anyaCodeFixDispatch.js:L360` (process.env)

### `ADVERSARIAL_MAX_AUTHOR_FILE_CHARS`

- **Templates**:
  - `.env.example:55` = ``
  - `backend/.env.example:24` = ``
- **Code references**:
  - `backend/services/anyaAdversarialRepairLoop.js:L58` (process.env)

### `ADVERSARIAL_MAX_VERIFY_DIFF_CHARS`

- **Templates**:
  - `.env.example:56` = ``
  - `backend/.env.example:25` = ``
- **Code references**:
  - `backend/services/anyaAdversarialRepairLoop.js:L56` (process.env)

### `ADVERSARIAL_VERIFIER_MAX_TOKENS`

- **Templates**:
  - `.env.example:57` = ``
  - `backend/.env.example:26` = ``
- **Code references**:
  - `backend/services/anyaAdversarialRepairLoop.js:L330` (process.env)

### `ADVERSARIAL_VERIFIER_MODEL`

- **Templates**:
  - `.env.example:58` = ``
  - `backend/.env.example:27` = ``
- **Code references**:
  - `backend/services/anyaAdversarialRepairLoop.js:L322` (process.env)

### `AGENT_CONTROL_ADMIN_EMAIL`

- **Templates**:
  - `.env.example:59` = ``
  - `backend/.env.example:28` = ``
- **Code references**:
  - `backend/server.js:L205` (process.env)
  - `backend/services/agentControl/agentAdapters/samAgentAdapter.js:L36` (process.env)
  - `backend/services/agentControl/agentControlOrchestrator.js:L173` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L238` (process.env)
  - `backend/tests/samCanonicalAdminEmail.test.js:L31–L77` (process.env)

### `ALERT_FAILURE_THRESHOLD`

- **Templates**:
  - `.env.example:60` = ``
  - `backend/.env.example:29` = ``
- **Code references**:
  - `backend/services/dataReadinessService.js:L206` (process.env)

### `ALERT_QUEUE_BACKLOG_THRESHOLD`

- **Templates**:
  - `.env.example:61` = ``
  - `backend/.env.example:30` = ``
- **Code references**:
  - `backend/services/dataReadinessService.js:L185` (process.env)

### `ALLOW_AUTO_ROUTE_GENERATION`

- **Templates**:
  - `.env.example:62` = ``
  - `backend/.env.example:31` = ``
- **Code references**:
  - `backend/services/anyaTestRepair.js:L20` (process.env)
  - `tests/unit/security-hardening.test.mjs:L44–L70` (process.env)

### `ALLOW_DESTRUCTIVE_SEED`

- **Templates**:
  - `.env.example:63` = ``
  - `backend/.env.example:32` = ``
- **Code references**:
  - `backend/scripts/seed-deterministic.mjs:L39` (process.env)

### `ALLOW_DEV_FILESYSTEM_AUDIT_LOGS`

- **Templates**:
  - `.env.example:64` = ``
  - `backend/.env.example:33` = ``
- **Code references**:
  - `backend/services/anyaAutonomousCrawler.js:L712` (process.env)
  - `backend/services/anyaAutonomousFunctionRunner.js:L64–L379` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L93–L718` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L123` (process.env)
  - `backend/services/nationalPrograms/audit.js:L45` (process.env)

### `ALLOW_EPHEMERAL_SQLITE`

- **Templates**:
  - `.env.example:65` = ``
  - `backend/.env.example:34` = ``
- **Code references**:
  - `backend/db/index.js:L781` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L10` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L13` (process.env)
  - `backend/server.js:L316` (process.env)
  - `backend/startup/bootstrap.js:L426` (process.env)

### `ALLOW_EPHEMERAL_UPLOADS`

- **Templates**:
  - `.env.example:66` = ``
  - `backend/.env.example:35` = ``
- **Code references**:
  - `backend/routes/health.js:L376` (process.env)
  - `backend/server.js:L288` (process.env)
  - `backend/startup/bootstrap.js:L27` (process.env)

### `ALLOW_LEGACY_PROFILE_TOKEN`

- **Templates**:
  - `.env.example:67` = ``
  - `backend/.env.example:36` = ``
- **Code references**:
  - `backend/middleware/authIdentity.js:L259` (process.env)
  - `backend/server.js:L1781` (process.env)
  - `tests/unit/authIdentity.test.mjs:L285–L337` (process.env)

### `ALLOW_OTP_LOGIN`

- **Templates**:
  - `.env.example:68` = ``
  - `backend/.env.example:37` = ``
- **Code references**:
  - `backend/routes/auth.js:L503` (process.env)
  - `backend/tests/otpLoginRetired.test.js:L53–L78` (process.env)

### `ALLOW_SQLITE_IN_PROD`

- **Templates**:
  - `.env.example:69` = ``
  - `backend/.env.example:38` = ``
- **Code references**:
  - `backend/db/index.js:L732` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L11` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L14` (process.env)

### `AMOUNT_ENRICH_BOOT_LIMIT`

- **Templates**:
  - `.env.example:70` = ``
  - `backend/.env.example:39` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3666` (process.env)

### `AMOUNT_ENRICH_ENV_MAX_ATTEMPTS`

- **Templates**:
  - `.env.example:71` = ``
  - `backend/.env.example:40` = ``
- **Code references**:
  - `backend/config/amountEnrichEnv.js:L35` (env helper)

### `AMOUNT_ENRICH_ENV_REPROBE_LIMIT`

- **Templates**:
  - `.env.example:72` = ``
  - `backend/.env.example:41` = ``
- **Code references**:
  - `backend/config/amountEnrichEnv.js:L38` (env helper)

### `AMOUNT_ENRICH_MAX_ATTEMPTS`

- **Templates**:
  - `.env.example:73` = ``
  - `backend/.env.example:42` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3668–L4118` (process.env)

### `AMOUNT_ENRICH_SYSTEMIC_STREAK`

- **Templates**:
  - `.env.example:74` = ``
  - `backend/.env.example:43` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3974–L4440` (process.env)

### `AMOUNT_ENRICH_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:75` = ``
  - `backend/.env.example:44` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3667` (process.env)

### `AMY_ADVERSARIAL`

- **Templates**:
  - `.env.example:76` = ``
  - `backend/.env.example:45` = ``
- **Code references**:
  - `backend/services/amy/amyAgent.js:L209` (process.env)

### `AMY_ADVERSARIAL_SHARE`

- **Templates**:
  - `.env.example:77` = ``
  - `backend/.env.example:46` = ``
- **Code references**:
  - `backend/services/amy/gapSeekingPlanner.js:L323` (process.env)

### `AMY_ANYA_APPLY`

- **Templates**:
  - `.env.example:78` = ``
  - `backend/.env.example:47` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L86` (process.env)

### `AMY_APPLY_COVERAGE`

- **Templates**:
  - `.env.example:79` = ``
  - `backend/.env.example:48` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L82` (process.env)

### `AMY_APPLY_LEARNING`

- **Templates**:
  - `.env.example:80` = ``
  - `backend/.env.example:49` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L83` (process.env)

### `AMY_APPLY_TUNING`

- **Templates**:
  - `.env.example:81` = ``
  - `backend/.env.example:50` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L80` (process.env)

### `AMY_APPLY_WEIGHTS`

- **Templates**:
  - `.env.example:82` = ``
  - `backend/.env.example:51` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L81` (process.env)

### `AMY_APPROVAL_LEDGER`

- **Templates**:
  - `.env.example:83` = ``
  - `backend/.env.example:52` = ``
- **Code references**:
  - `backend/services/amy/approvalLedger.js:L186` (process.env)

### `AMY_APPROVAL_STALE_NIGHTS`

- **Templates**:
  - `.env.example:84` = ``
  - `backend/.env.example:53` = ``
- **Code references**:
  - `backend/services/amy/approvalLedger.js:L179` (process.env)
  - `backend/tests/amyApprovalLedger.test.js:L103–L129` (process.env)

### `AMY_AUTO_CLEANUP`

- **Templates**:
  - `.env.example:85` = ``
  - `backend/.env.example:54` = ``
- **Code references**:
  - `backend/services/maintenance/nightlySweep.js:L224` (process.env)

### `AMY_CLEANUP_GRACE_HOURS`

- **Templates**:
  - `.env.example:86` = ``
  - `backend/.env.example:55` = ``
- **Code references**:
  - `backend/services/maintenance/nightlySweep.js:L227` (process.env)

### `AMY_CRAWLER_RESEARCH`

- **Templates**:
  - `.env.example:87` = ``
  - `backend/.env.example:56` = ``
- **Code references**:
  - `backend/services/amy/crawlerCompetitiveResearch.js:L121` (process.env)
  - `backend/tests/crawlerCompetitiveResearch.test.js:L239–L247` (process.env)

### `AMY_DAILY_PROFILE_TARGET`

- **Templates**:
  - `.env.example:88` = ``
  - `backend/.env.example:57` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L73` (process.env)
  - `backend/services/amy/flywheelCohort.js:L45` (process.env)
  - `backend/tests/amyAgent.test.js:L440` (process.env)

### `AMY_ENABLED`

- **Templates**:
  - `.env.example:89` = ``
  - `backend/.env.example:58` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L68` (process.env)
  - `backend/tests/amyAgent.test.js:L437–L449` (process.env)

### `AMY_FLOOR`

- **Templates**:
  - `.env.example:90` = ``
  - `backend/.env.example:59` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L78–L78` (process.env)

### `AMY_FLYWHEEL_REPORT_EMAIL`

- **Templates**:
  - `.env.example:91` = ``
  - `backend/.env.example:60` = ``
- **Code references**:
  - `backend/services/amy/flywheelCohort.js:L361` (process.env)

### `AMY_GAP_LEARNING`

- **Templates**:
  - `.env.example:92` = ``
  - `backend/.env.example:61` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L84` (process.env)

### `AMY_GAP_SCAN_LIMIT`

- **Templates**:
  - `.env.example:93` = ``
  - `backend/.env.example:62` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L85` (process.env)

### `AMY_IMPROVE`

- **Templates**:
  - `.env.example:94` = ``
  - `backend/.env.example:63` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L79` (process.env)

### `AMY_INTERVAL_MS`

- **Templates**:
  - `.env.example:95` = ``
  - `backend/.env.example:64` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L88–L88` (process.env)

### `AMY_KEEP_PROFILES`

- **Templates**:
  - `.env.example:96` = ``
  - `backend/.env.example:65` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L77` (process.env)

### `AMY_NEVER_CRAWLED_MAX_AGE_HOURS`

- **Templates**:
  - `.env.example:97` = ``
  - `backend/.env.example:66` = ``
- **Code references**:
  - `backend/tests/enforceInvariants.test.js:L5141–L5145` (process.env)

### `AMY_PERSIST`

- **Templates**:
  - `.env.example:98` = ``
  - `backend/.env.example:67` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L76` (process.env)

### `AMY_PROBE_COVERAGE`

- **Templates**:
  - `.env.example:99` = ``
  - `backend/.env.example:68` = ``
- **Code references**:
  - `backend/services/amy/probeCoverageLedger.js:L257` (process.env)

### `AMY_REPO_REWARDS`

- **Templates**:
  - `.env.example:100` = ``
  - `backend/.env.example:69` = ``
- **Code references**:
  - `backend/services/amy/repoRewardsScout.js:L50` (process.env)
  - `backend/tests/crawlerCompetitiveResearch.test.js:L93–L234` (process.env)
  - `backend/tests/repoRewardsScout.test.js:L117–L129` (process.env)

### `AMY_RUN_ON_SCHEDULE`

- **Templates**:
  - `.env.example:101` = ``
  - `backend/.env.example:70` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L71` (process.env)
  - `backend/tests/amyAgent.test.js:L438` (process.env)

### `AMY_RUN_ON_STARTUP`

- **Templates**:
  - `.env.example:102` = ``
  - `backend/.env.example:71` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L72` (process.env)
  - `backend/tests/amyAgent.test.js:L418–L439` (process.env)

### `AMY_SAM_APPLY`

- **Templates**:
  - `.env.example:103` = ``
  - `backend/.env.example:72` = ``
- **Code references**:
  - `backend/services/amy/amyScheduler.js:L87` (process.env)

### `ANTHROPIC_API_KEY`

- **Templates**:
  - `.env.example:104` = `<REPLACE_ME>`
  - `backend/.env.example:73` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/admin.js:L595–L598` (process.env)
  - `backend/routes/ai.js:L127–L131` (process.env)
  - `backend/routes/anya.js:L150–L215` (process.env)
  - `backend/routes/nofo.js:L37–L40` (process.env)
  - `backend/routes/profiles.js:L600–L604` (process.env)
  - `backend/services/anyaOrchestrator.js:L39` (process.env)
  - `backend/services/diagnosticsService.js:L407` (process.env)
  - `backend/services/documentIngestion.js:L73–L942` (process.env)
  - `backend/services/errorReporter.js:L130` (process.env)
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L119` (process.env)
  - `backend/services/hamilton/portalSync/llmPageExtract.js:L95` (process.env)
  - `backend/services/john/johnEmailComposerAI.js:L54–L60` (process.env)
  - `backend/services/laptopConnector/laptopAnalyzer.js:L29` (process.env)
  - `backend/services/pipelineAutomation.js:L102` (process.env)
  - `backend/tests/johnOrgResearch.test.js:L92` (process.env)
  - `backend/tests/portalLlmExtract.test.js:L47–L87` (process.env)
  - `backend/tests/profileSectionAiFallback.test.js:L11` (process.env)
  - `backend/utils/aiProviders.js:L11` (process.env)
  - `scripts/diagnose-anya.mjs:L35–L48` (process.env)

### `ANTHROPIC_MAX_RETRIES`

- **Templates**:
  - `.env.example:105` = ``
  - `backend/.env.example:74` = ``
- **Code references**:
  - `backend/utils/aiProviders.js:L28` (process.env)

### `ANTHROPIC_MODEL`

- **Templates**:
  - `.env.example:106` = ``
  - `backend/.env.example:75` = ``
- **Code references**:
  - `backend/routes/admin.js:L720` (process.env)
  - `backend/routes/ai.js:L218–L770` (process.env)
  - `backend/routes/nofo.js:L267` (process.env)
  - `backend/routes/profiles.js:L3723–L3917` (process.env)
  - `backend/services/anyaAdversarialRepairLoop.js:L295` (process.env)
  - `backend/services/anyaOrchestrator.js:L64–L1688` (process.env)
  - `backend/services/documentIngestion.js:L996` (process.env)
  - `backend/services/errorReporter.js:L198` (process.env)
  - `backend/services/fundingTraceService.js:L223` (process.env)
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L130` (process.env)
  - `backend/services/john/johnEmailComposerAI.js:L47` (process.env)
  - `backend/services/laptopConnector/laptopAnalyzer.js:L40` (process.env)
  - `backend/services/pipelineAutomation.js:L507` (process.env)
  - `backend/utils/aiProviders.js:L148–L237` (process.env)

### `ANTHROPIC_MODEL_SCHOOL_LOOKUP`

- **Templates**:
  - `.env.example:107` = ``
  - `backend/.env.example:76` = ``
- **Code references**:
  - `backend/routes/ai.js:L2188` (process.env)
  - `backend/services/hamilton/hamiltonFullProposalGenerator.js:L59` (process.env)

### `ANTHROPIC_TIMEOUT_MS`

- **Templates**:
  - `.env.example:108` = ``
  - `backend/.env.example:77` = ``
- **Code references**:
  - `backend/utils/aiProviders.js:L27` (process.env)

### `ANYA_ADMIN_GEO_COOLDOWN_HOURS`

- **Templates**:
  - `.env.example:109` = ``
  - `backend/.env.example:78` = ``
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L31` (process.env)

### `ANYA_ADMIN_GEO_OVERPASS_MAX`

- **Templates**:
  - `.env.example:110` = ``
  - `backend/.env.example:79` = ``
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L118` (process.env)

### `ANYA_ADMIN_GEO_OVERPASS_RADIUS_KM`

- **Templates**:
  - `.env.example:111` = ``
  - `backend/.env.example:80` = ``
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L117` (process.env)

### `ANYA_ADMIN_GEO_STATE_PACING_MS`

- **Templates**:
  - `.env.example:112` = ``
  - `backend/.env.example:81` = ``
- **Code references**:
  - `backend/services/adminGeoCrawlOnLogin.js:L114` (process.env)

### `ANYA_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:113` = `<REPLACE_ME>`
  - `backend/.env.example:82` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/anya.js:L26` (process.env)
  - `backend/routes/authMe.js:L287` (process.env)
  - `backend/routes/blocklist.js:L35` (process.env)
  - `backend/routes/emailGrants.js:L31` (process.env)
  - `backend/routes/john.js:L72` (process.env)
  - `backend/routes/robert.js:L63` (process.env)
  - `backend/routes/sam.js:L180` (process.env)
  - `backend/routes/vehicles.js:L38` (process.env)
  - `backend/server.js:L187–L1908` (process.env)
  - `backend/services/anyaAdminTools.js:L1367` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L220` (process.env)
  - `backend/services/anyaStartupAudit.js:L42` (process.env)
  - `backend/services/anyaToolRegistry.js:L4240–L4419` (process.env)
  - `backend/services/codeGuardService.js:L83` (process.env)
  - `backend/services/diagnosticsService.js:L412` (process.env)
  - `backend/services/sam/samHttpProbe.js:L54` (process.env)
  - `backend/tests/testServer.js:L19` (process.env)
  - `scripts/_lib/secrets.mjs:L22` (process.env)
  - `scripts/dedupe-profiles.mjs:L29` (process.env)
  - `scripts/verify-prod-issues.mjs:L12` (process.env)

### `ANYA_ANTHROPIC_COOLDOWN_MS`

- **Templates**:
  - `.env.example:114` = ``
  - `backend/.env.example:83` = ``
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L34` (process.env)

### `ANYA_ANTHROPIC_FAILURE_THRESHOLD`

- **Templates**:
  - `.env.example:115` = ``
  - `backend/.env.example:84` = ``
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L33` (process.env)

### `ANYA_ANTHROPIC_MAX_RETRIES`

- **Templates**:
  - `.env.example:116` = ``
  - `backend/.env.example:85` = ``
- **Code references**:
  - `backend/routes/admin.js:L600` (process.env)
  - `backend/routes/ai.js:L133` (process.env)
  - `backend/routes/anya.js:L173` (process.env)
  - `backend/routes/nofo.js:L42` (process.env)
  - `backend/routes/profiles.js:L606` (process.env)
  - `backend/services/anyaOrchestrator.js:L45` (process.env)
  - `backend/services/documentIngestion.js:L80` (process.env)
  - `backend/services/pipelineAutomation.js:L108` (process.env)
  - `backend/utils/aiProviders.js:L28` (process.env)

### `ANYA_ANTHROPIC_TIMEOUT_MS`

- **Templates**:
  - `.env.example:117` = ``
  - `backend/.env.example:86` = ``
- **Code references**:
  - `backend/routes/admin.js:L599` (process.env)
  - `backend/routes/ai.js:L132` (process.env)
  - `backend/routes/anya.js:L172` (process.env)
  - `backend/routes/nofo.js:L41` (process.env)
  - `backend/routes/profiles.js:L605` (process.env)
  - `backend/services/anyaOrchestrator.js:L44` (process.env)
  - `backend/services/documentIngestion.js:L79` (process.env)
  - `backend/services/pipelineAutomation.js:L107` (process.env)
  - `backend/utils/aiProviders.js:L27` (process.env)

### `ANYA_API_KEY`

- **Templates**:
  - `.env.example:118` = `<REPLACE_ME>`
  - `backend/.env.example:87` = `<REPLACE_ME>`
- **Code references**:
  - `backend/middleware/authIdentity.js:L56` (process.env)
  - `backend/server.js:L1658–L1693` (process.env)
  - `tests/unit/authIdentity.test.mjs:L119–L375` (process.env)

### `ANYA_AUTONOMOUS_ENABLED`

- **Templates**:
  - `.env.example:119` = ``
  - `backend/.env.example:88` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L36` (process.env)
  - `backend/services/anyaBootstrap.js:L76` (process.env)
  - `backend/tests/testServer.js:L22` (process.env)
  - `scripts/check-anya-status.mjs:L50–L102` (process.env)

### `ANYA_BG_REPLY_TIMEOUT_MS`

- **Templates**:
  - `.env.example:120` = ``
  - `backend/.env.example:89` = ``
- **Code references**:
  - `backend/routes/anya.js:L407` (process.env)

### `ANYA_CHECK_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:121` = `<REPLACE_ME>`
  - `backend/.env.example:90` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/check-anya-status.mjs:L32` (env helper)

### `ANYA_CHECK_API_BASE`

- **Templates**:
  - `.env.example:122` = ``
  - `backend/.env.example:91` = ``
- **Code references**:
  - `scripts/check-anya-status.mjs:L31` (env helper)

### `ANYA_CODE_CRAWL`

- **Templates**:
  - `.env.example:123` = ``
  - `backend/.env.example:92` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L50` (process.env)

### `ANYA_CODE_REPAIR_PRODUCTION_WRITES`

- **Templates**:
  - `.env.example:124` = ``
  - `backend/.env.example:93` = ``
- **Code references**:
  - `backend/routes/admin.js:L5576` (process.env)
  - `backend/services/anyaAutonomousCrawler.js:L771` (process.env)
  - `backend/tests/adminAnyaRunAutonomousRoute.test.js:L157–L168` (process.env)
  - `backend/tests/anyaAutonomousCrawler.real.test.js:L540–L556` (process.env)

### `ANYA_CRAWLERS`

- **Templates**:
  - `.env.example:125` = ``
  - `backend/.env.example:94` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L52` (process.env)

### `ANYA_DAILY_REPORT_EMAIL`

- **Templates**:
  - `.env.example:126` = ``
  - `backend/.env.example:95` = ``
- **Code references**:
  - `backend/services/amy/flywheelCohort.js:L362` (process.env)
  - `backend/services/anya/anyaDailyOwnerReport.js:L37` (process.env)

### `ANYA_DAILY_REPORT_ENABLED`

- **Templates**:
  - `.env.example:127` = ``
  - `backend/.env.example:96` = ``
- **Code references**:
  - `backend/services/anya/anyaDailyOwnerReport.js:L33` (process.env)
  - `backend/tests/anyaDailyOwnerReport.test.js:L242–L250` (process.env)
  - `backend/tests/evaOwnerReport.test.js:L137` (process.env)

### `ANYA_DAILY_REPORT_HOUR_ET`

- **Templates**:
  - `.env.example:128` = ``
  - `backend/.env.example:97` = ``
- **Code references**:
  - `backend/server.js:L4138` (process.env)

### `ANYA_DRY_RUN`

- **Templates**:
  - `.env.example:129` = ``
  - `backend/.env.example:98` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L68–L80` (process.env)

### `ANYA_FIX_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:130` = `<REPLACE_ME>`
  - `backend/.env.example:99` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/trigger-anya-fix-tests.mjs:L33` (env helper)

### `ANYA_FIX_API_BASE`

- **Templates**:
  - `.env.example:131` = ``
  - `backend/.env.example:100` = ``
- **Code references**:
  - `scripts/trigger-anya-fix-tests.mjs:L21` (env helper)

### `ANYA_FIX_CONFIRM`

- **Templates**:
  - `.env.example:132` = ``
  - `backend/.env.example:101` = ``
- **Code references**:
  - `scripts/trigger-anya-fix-tests.mjs:L34` (env helper)

### `ANYA_FIX_CONFIRM_MUTATING_HOST`

- **Templates**:
  - `.env.example:133` = ``
  - `backend/.env.example:102` = ``
- **Code references**:
  - `scripts/trigger-anya-fix-tests.mjs:L29` (env helper)

### `ANYA_FIX_CONSOLE`

- **Templates**:
  - `.env.example:134` = ``
  - `backend/.env.example:103` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L65` (process.env)

### `ANYA_FIX_EMPTY_CATCH`

- **Templates**:
  - `.env.example:135` = ``
  - `backend/.env.example:104` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L66` (process.env)

### `ANYA_FIX_ERRORS`

- **Templates**:
  - `.env.example:136` = ``
  - `backend/.env.example:105` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L79` (process.env)

### `ANYA_FUNCTION_TESTS`

- **Templates**:
  - `.env.example:137` = ``
  - `backend/.env.example:106` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L51` (process.env)

### `ANYA_FUNCTION_TEST_TIMEOUT_MS`

- **Templates**:
  - `.env.example:138` = ``
  - `backend/.env.example:107` = ``
- **Code references**:
  - `backend/services/anyaAutonomousFunctionTesting.js:L321` (process.env)

### `ANYA_GEO_CRAWL`

- **Templates**:
  - `.env.example:139` = ``
  - `backend/.env.example:108` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L55` (process.env)

### `ANYA_HEALTH_INTERVAL_MS`

- **Templates**:
  - `.env.example:140` = ``
  - `backend/.env.example:109` = ``
- **Code references**:
  - `backend/services/anyaHealthService.js:L418` (process.env)
  - `tests/unit/health-service-singleton.test.mjs:L14` (process.env)

### `ANYA_ITEM_DISCOVERY`

- **Templates**:
  - `.env.example:141` = ``
  - `backend/.env.example:110` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L53` (process.env)

### `ANYA_ITEM_DISCOVERY_LIMIT`

- **Templates**:
  - `.env.example:142` = ``
  - `backend/.env.example:111` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L84` (process.env)

### `ANYA_ITEM_DISCOVERY_MIN_COUNT`

- **Templates**:
  - `.env.example:143` = ``
  - `backend/.env.example:112` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L83` (process.env)

### `ANYA_LEGACY_CRAWLER_CONTEXT_WARNING`

- **Templates**:
  - `.env.example:144` = ``
  - `backend/.env.example:113` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L250` (process.env)

### `ANYA_MATCH_SCOUT`

- **Templates**:
  - `.env.example:145` = ``
  - `backend/.env.example:114` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L56` (process.env)

### `ANYA_MATCH_SCOUT_CANDIDATE_LIMIT`

- **Templates**:
  - `.env.example:146` = ``
  - `backend/.env.example:115` = ``
- **Code references**:
  - `backend/services/anyaMatchScout.js:L61` (process.env)

### `ANYA_MATCH_SCOUT_MAX_ALERTS_PER_PROFILE`

- **Templates**:
  - `.env.example:147` = ``
  - `backend/.env.example:116` = ``
- **Code references**:
  - `backend/services/anyaMatchScout.js:L55` (process.env)

### `ANYA_MATCH_SCOUT_THRESHOLD`

- **Templates**:
  - `.env.example:148` = ``
  - `backend/.env.example:117` = ``
- **Code references**:
  - `backend/services/anyaMatchScout.js:L49` (process.env)

### `ANYA_MAX_FILE_CHANGES`

- **Templates**:
  - `.env.example:149` = ``
  - `backend/.env.example:118` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L67` (process.env)

### `ANYA_OPENAI_COOLDOWN_MS`

- **Templates**:
  - `.env.example:150` = ``
  - `backend/.env.example:119` = ``
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L20` (process.env)

### `ANYA_OPENAI_FAILURE_THRESHOLD`

- **Templates**:
  - `.env.example:151` = ``
  - `backend/.env.example:120` = ``
- **Code references**:
  - `backend/services/anyaOrchestrator.js:L19` (process.env)

### `ANYA_OPENAI_MAX_RETRIES`

- **Templates**:
  - `.env.example:152` = ``
  - `backend/.env.example:121` = ``
- **Code references**:
  - `backend/utils/openaiClient.js:L78` (process.env)

### `ANYA_OPENAI_MODEL`

- **Templates**:
  - `.env.example:153` = ``
  - `backend/.env.example:122` = ``
- **Code references**:
  - `backend/services/anyaAdversarialRepairLoop.js:L324` (process.env)
  - `backend/services/anyaOrchestrator.js:L63` (process.env)
  - `backend/services/anyaToolRegistry.js:L1013–L3762` (process.env)
  - `backend/utils/aiProviders.js:L127–L201` (process.env)

### `ANYA_OPENAI_TIMEOUT_MS`

- **Templates**:
  - `.env.example:154` = ``
  - `backend/.env.example:123` = ``
- **Code references**:
  - `backend/utils/openaiClient.js:L73` (process.env)

### `ANYA_PORTAL_CHECKS`

- **Templates**:
  - `.env.example:155` = ``
  - `backend/.env.example:124` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L54` (process.env)

### `ANYA_REPLY_TIMEOUT_MS`

- **Templates**:
  - `.env.example:156` = ``
  - `backend/.env.example:125` = ``
- **Code references**:
  - `backend/routes/anya.js:L35` (process.env)

### `ANYA_RUN_ON_ADMIN_LOGIN`

- **Templates**:
  - `.env.example:157` = ``
  - `backend/.env.example:126` = ``
- **Code references**:
  - `backend/routes/auth.js:L2756` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L40` (process.env)

### `ANYA_RUN_ON_SCHEDULE`

- **Templates**:
  - `.env.example:158` = ``
  - `backend/.env.example:127` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L41` (process.env)
  - `backend/services/anyaBootstrap.js:L103` (process.env)
  - `backend/startup/backgroundServices.js:L248` (process.env)

### `ANYA_RUN_ON_STARTUP`

- **Templates**:
  - `.env.example:159` = ``
  - `backend/.env.example:128` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L39` (process.env)
  - `backend/services/anyaBootstrap.js:L61` (process.env)
  - `backend/startup/backgroundServices.js:L236` (process.env)
  - `scripts/check-anya-status.mjs:L51` (process.env)

### `ANYA_SAVE_GLOBAL`

- **Templates**:
  - `.env.example:160` = ``
  - `backend/.env.example:129` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L75` (process.env)

### `ANYA_SCHEDULE`

- **Templates**:
  - `.env.example:161` = ``
  - `backend/.env.example:130` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L60` (process.env)

### `ANYA_SELF_BASE_URL`

- **Templates**:
  - `.env.example:162` = `http://127.0.0.1:8080`
  - `backend/.env.example:131` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/anyaAutonomousFunctionTesting.js:L209` (process.env)
  - `backend/services/anyaToolRegistry.js:L4278` (process.env)
  - `backend/utils/internalSelfBaseUrl.js:L25` (process.env)

### `ANYA_TOOL_FAILURE_WINDOW_HOURS`

- **Templates**:
  - `.env.example:163` = ``
  - `backend/.env.example:132` = ``
- **Code references**:
  - `backend/services/sam/samRegistry.js:L2195` (process.env)
  - `backend/tests/samRateWindowRecency.test.js:L101–L106` (process.env)

### `ANYA_USAGE_RETENTION_DAYS`

- **Templates**:
  - `.env.example:164` = ``
  - `backend/.env.example:133` = ``
- **Code references**:
  - `backend/jobs/anyaBrainCleanup.js:L28` (process.env)

### `ANYA_WAIT_COMPLETION`

- **Templates**:
  - `.env.example:165` = ``
  - `backend/.env.example:134` = ``
- **Code references**:
  - `backend/services/anyaAutonomousScheduler.js:L76` (process.env)

### `API_BASE`

- **Templates**:
  - `.env.example:166` = ``
  - `backend/.env.example:135` = ``
- **Code references**:
  - `backend/scripts/check-crawler-results.mjs:L24` (process.env)

### `API_BASE_URL`

- **Templates**:
  - `.env.example:167` = `http://127.0.0.1:8080`
  - `backend/.env.example:136` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/smoke-auth-diagnostics.mjs:L12` (process.env)
  - `scripts/verify-prod-issues.mjs:L11` (process.env)
  - `tests/e2e/playwright.config.mjs:L8` (process.env)
  - `tests/smoke/playwright.config.mjs:L4` (process.env)

### `API_DATA_GOV_KEY`

- **Templates**:
  - `.env.example:168` = `<REPLACE_ME>`
  - `backend/.env.example:137` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/diagnosticsService.js:L405` (process.env)
  - `backend/src/config/apiKeys.js:L50` (env helper)

### `API_URL`

- **Templates**:
  - `.env.example:169` = `http://127.0.0.1:8080`
  - `backend/.env.example:138` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/diagnose-anya.mjs:L22` (process.env)

### `APPLICATION_EMAIL`

- **Templates**:
  - `.env.example:170` = ``
  - `backend/.env.example:139` = ``
- **Code references**:
  - `backend/routes/profiles.js:L4357` (process.env)

### `APPLY`

- **Templates**:
  - `.env.example:171` = ``
  - `backend/.env.example:140` = ``
- **Code references**:
  - `backend/scripts/repair-profile-ownership.mjs:L167` (process.env)

### `APPLY_STORAGE_DIR`

- **Templates**:
  - `.env.example:172` = ``
  - `backend/.env.example:141` = ``
- **Code references**:
  - `backend/apply/storageAdapter.js:L9` (process.env)
  - `backend/scripts/smoke-apply-engine.mjs:L60` (process.env)
  - `backend/tests/applyEnginePortalUrlIntegrity.test.js:L43` (process.env)

### `APP_BASE_PATH`

- **Templates**:
  - `.env.example:173` = ``
  - `backend/.env.example:142` = ``
- **Code references**:
  - `backend/routes/auth.js:L204` (process.env)

### `AUTH_ACCESS_TOKEN_TTL`

- **Templates**:
  - `.env.example:174` = `600`
  - `backend/.env.example:143` = `600`
- **Code references**:
  - `backend/routes/auth.js:L166` (process.env)

### `AUTH_EMAIL_CODE_TTL`

- **Templates**:
  - `.env.example:175` = `600`
  - `backend/.env.example:144` = `600`
- **Code references**:
  - `backend/routes/auth.js:L173` (process.env)

### `AUTH_EMAIL_FROM`

- **Templates**:
  - `.env.example:176` = ``
  - `backend/.env.example:145` = ``
- **Code references**:
  - `backend/tests/onboardingRoute.test.js:L188` (process.env)

### `AUTH_EMAIL_MAX_VERIFY_ATTEMPTS`

- **Templates**:
  - `.env.example:177` = ``
  - `backend/.env.example:146` = ``
- **Code references**:
  - `backend/routes/auth.js:L178` (process.env)

### `AUTH_EMAIL_RATE_LIMIT`

- **Templates**:
  - `.env.example:178` = ``
  - `backend/.env.example:147` = ``
- **Code references**:
  - `backend/routes/auth.js:L359` (process.env)
  - `backend/tests/otpEmailSendCompensation.test.js:L15` (process.env)
  - `backend/tests/otpStartOrdering.test.js:L24` (process.env)

### `AUTH_EMAIL_RESEND_SECONDS`

- **Templates**:
  - `.env.example:179` = ``
  - `backend/.env.example:148` = ``
- **Code references**:
  - `backend/routes/auth.js:L174` (process.env)

### `AUTH_EMAIL_SEND_TIMEOUT_MS`

- **Templates**:
  - `.env.example:180` = ``
  - `backend/.env.example:149` = ``
- **Code references**:
  - `backend/routes/auth.js:L2494–L3401` (process.env)
  - `backend/tests/adminReinterviewGate.test.js:L24` (process.env)
  - `backend/tests/onboardingRoute.test.js:L184` (process.env)
  - `backend/tests/otpEmailSendCompensation.test.js:L98–L133` (process.env)
  - `backend/tests/refreshLoginRecording.test.js:L25` (process.env)

### `AUTH_EMAIL_VERIFY_RATE_LIMIT`

- **Templates**:
  - `.env.example:181` = ``
  - `backend/.env.example:150` = ``
- **Code references**:
  - `backend/routes/auth.js:L384` (process.env)

### `AUTH_FRONTEND_APP_BASE`

- **Templates**:
  - `.env.example:182` = ``
  - `backend/.env.example:151` = ``
- **Code references**:
  - `backend/routes/auth.js:L204` (process.env)
  - `backend/server.js:L270–L708` (process.env)

### `AUTH_FRONTEND_URL`

- **Templates**:
  - `.env.example:183` = `http://127.0.0.1:8080`
  - `backend/.env.example:152` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/routes/auth.js:L202` (process.env)
  - `backend/services/diagnosticsService.js:L416` (process.env)

### `AUTH_JWT_SECRET`

- **Templates**:
  - `.env.example:184` = `<REPLACE_ME>`
  - `backend/.env.example:153` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/authMe.js:L284` (process.env)
  - `backend/routes/health.js:L102` (process.env)
  - `backend/server.js:L1589–L1905` (process.env)
  - `backend/tests/adminReinterviewGate.test.js:L23–L23` (process.env)
  - `backend/tests/refreshLoginRecording.test.js:L24–L24` (process.env)
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

- **Templates**:
  - `.env.example:185` = ``
  - `backend/.env.example:154` = ``
- **Code references**:
  - `backend/services/diagnosticsService.js:L411` (process.env)
  - `backend/services/email.js:L329` (process.env)

### `AUTH_NOTIFY_ON_LOGIN`

- **Templates**:
  - `.env.example:186` = ``
  - `backend/.env.example:155` = ``
- **Code references**:
  - `backend/services/diagnosticsService.js:L410` (process.env)
  - `backend/services/email.js:L328` (process.env)

### `AUTH_OAUTH_STATE_TTL`

- **Templates**:
  - `.env.example:187` = `600`
  - `backend/.env.example:156` = `600`
- **Code references**:
  - `backend/routes/auth.js:L182` (process.env)

### `AUTH_PASSWORD_RATE_LIMIT`

- **Templates**:
  - `.env.example:188` = `<REPLACE_ME>`
  - `backend/.env.example:157` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/auth.js:L373` (process.env)

### `AUTH_PASSWORD_SETUP_TTL`

- **Templates**:
  - `.env.example:189` = `600`
  - `backend/.env.example:158` = `600`
- **Code references**:
  - `backend/routes/auth.js:L183` (process.env)

### `AUTH_PHONE_CODE_TTL`

- **Templates**:
  - `.env.example:190` = `600`
  - `backend/.env.example:159` = `600`
- **Code references**:
  - `backend/routes/auth.js:L180` (process.env)

### `AUTH_PHONE_MAX_VERIFY_ATTEMPTS`

- **Templates**:
  - `.env.example:191` = ``
  - `backend/.env.example:160` = ``
- **Code references**:
  - `backend/routes/auth.js:L179` (process.env)

### `AUTH_PHONE_RATE_LIMIT`

- **Templates**:
  - `.env.example:192` = ``
  - `backend/.env.example:161` = ``
- **Code references**:
  - `backend/routes/auth.js:L366` (process.env)
  - `backend/tests/otpStartOrdering.test.js:L25` (process.env)

### `AUTH_PHONE_RESEND_SECONDS`

- **Templates**:
  - `.env.example:193` = ``
  - `backend/.env.example:162` = ``
- **Code references**:
  - `backend/routes/auth.js:L181` (process.env)

### `AUTH_PUBLIC_URL`

- **Templates**:
  - `.env.example:194` = `http://127.0.0.1:8080`
  - `backend/.env.example:163` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/routes/auth.js:L201` (process.env)
  - `backend/routes/stripe.js:L23` (process.env)
  - `backend/services/diagnosticsService.js:L415` (process.env)

### `AUTH_REFRESH_RACE_GRACE_MS`

- **Templates**:
  - `.env.example:195` = ``
  - `backend/.env.example:164` = ``
- **Code references**:
  - `backend/routes/auth.js:L171` (process.env)

### `AUTH_REFRESH_TOKEN_TTL`

- **Templates**:
  - `.env.example:196` = `600`
  - `backend/.env.example:165` = `600`
- **Code references**:
  - `backend/routes/auth.js:L167` (process.env)

### `AUTH_TOKEN`

- **Templates**:
  - `.env.example:197` = `<REPLACE_ME>`
  - `backend/.env.example:166` = `<REPLACE_ME>`
- **Code references**:
  - `backend/scripts/check-crawler-results.mjs:L25` (process.env)
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L27` (process.env)

### `AUTO_DISCOVERY_DAILY_ENABLED`

- **Templates**:
  - `.env.example:198` = ``
  - `backend/.env.example:167` = ``
- **Code references**:
  - `backend/server.js:L3691` (process.env)
  - `backend/services/anyaBootstrap.js:L123` (process.env)
  - `backend/services/scheduledAutoDiscovery.js:L23` (process.env)
  - `backend/startup/backgroundServices.js:L266` (process.env)

### `AUTO_DISCOVERY_DAILY_HOUR`

- **Templates**:
  - `.env.example:199` = ``
  - `backend/.env.example:168` = ``
- **Code references**:
  - `backend/services/scheduledAutoDiscovery.js:L24` (process.env)

### `AUTO_POPULATE_PER_SECTION_TIMEOUT_MS`

- **Templates**:
  - `.env.example:200` = ``
  - `backend/.env.example:169` = ``
- **Code references**:
  - `backend/apply/applyEngine.js:L1409` (process.env)

### `AUTO_POPULATE_TOTAL_BUDGET_MS`

- **Templates**:
  - `.env.example:201` = ``
  - `backend/.env.example:170` = ``
- **Code references**:
  - `backend/apply/applyEngine.js:L1412` (process.env)

### `AWS_ACCESS_KEY_ID`

- **Templates**:
  - `.env.example:202` = `<REPLACE_ME>`
  - `backend/.env.example:171` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/documentIngestion/ocr/providers/awsTextract.js:L22–L24` (process.env)

### `AWS_DEFAULT_REGION`

- **Templates**:
  - `.env.example:203` = ``
  - `backend/.env.example:172` = ``
- **Code references**:
  - `backend/services/documentIngestion/ocr/providers/awsTextract.js:L19` (env helper)

### `AWS_REGION`

- **Templates**:
  - `.env.example:204` = ``
  - `backend/.env.example:173` = ``
- **Code references**:
  - `backend/services/documentIngestion/ocr/providers/awsTextract.js:L19` (process.env)

### `AWS_SECRET_ACCESS_KEY`

- **Templates**:
  - `.env.example:205` = `<REPLACE_ME>`
  - `backend/.env.example:174` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/documentIngestion/ocr/providers/awsTextract.js:L25` (env helper)

### `AWS_SESSION_TOKEN`

- **Templates**:
  - `.env.example:206` = `<REPLACE_ME>`
  - `backend/.env.example:175` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/documentIngestion/ocr/providers/awsTextract.js:L26` (process.env)

### `BACKEND_BASE_URL`

- **Templates**:
  - `.env.example:207` = `http://127.0.0.1:8080`
  - `backend/.env.example:176` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L80–L127` (process.env)

### `BACKEND_PORT`

- **Templates**:
  - `.env.example:208` = `8080`
  - `backend/.env.example:177` = `8080`
- **Code references**:
  - `backend/services/anyaAdminTools.js:L1332` (process.env)
  - `scripts/runtime-crawl-local.mjs:L78` (process.env)

### `BASELINE_SEED_MODE`

- **Templates**:
  - `.env.example:209` = ``
  - `backend/.env.example:178` = ``
- **Code references**:
  - `backend/server.js:L1340` (process.env)
  - `backend/startup/selfHeal.js:L98` (process.env)
  - `backend/tests/selfHealObservability.test.js:L38–L43` (process.env)

### `BASE_URL`

- **Templates**:
  - `.env.example:210` = `http://127.0.0.1:8080`
  - `backend/.env.example:179` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/run-all-real-crawlers.mjs:L5` (process.env)
  - `src/components/banners/ProBonoBanner.jsx:L9` (import.meta.env)
  - `src/config/env.js:L33` (import.meta.env)
  - `src/utils/enforceBasename.js:L13` (import.meta.env)
  - `src/utils/index.js:L27` (import.meta.env)

### `BEARER_TOKEN`

- **Templates**:
  - `.env.example:211` = `<REPLACE_ME>`
  - `backend/.env.example:180` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L25` (process.env)

### `BEHAVIOR_LEARNING_ENABLED`

- **Templates**:
  - `.env.example:212` = ``
  - `backend/.env.example:181` = ``
- **Code references**:
  - `backend/services/behaviorLearning.js:L63` (process.env)
  - `backend/tests/behaviorLearning.test.js:L66` (process.env)

### `BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE`

- **Templates**:
  - `.env.example:213` = ``
  - `backend/.env.example:182` = ``
- **Code references**:
  - `backend/services/billing/invoiceService.js:L257` (process.env)

### `BILLING_AUTOMATION_ENABLED`

- **Templates**:
  - `.env.example:214` = ``
  - `backend/.env.example:183` = ``
- **Code references**:
  - `backend/services/billing/invoiceService.js:L30` (process.env)

### `BILLING_CYCLE_INTERVAL_MS`

- **Templates**:
  - `.env.example:215` = ``
  - `backend/.env.example:184` = ``
- **Code references**:
  - `backend/server.js:L3803` (process.env)

### `BILLING_OWNER_CC`

- **Templates**:
  - `.env.example:216` = ``
  - `backend/.env.example:185` = ``
- **Code references**:
  - `backend/services/billing/accountStatus.js:L25` (process.env)
  - `backend/services/billing/invoiceService.js:L33` (process.env)

### `BILLING_SECOND_NOTICE_DAYS`

- **Templates**:
  - `.env.example:217` = ``
  - `backend/.env.example:186` = ``
- **Code references**:
  - `backend/services/billing/invoiceService.js:L35` (process.env)

### `BILLING_SUSPEND_DAYS`

- **Templates**:
  - `.env.example:218` = ``
  - `backend/.env.example:187` = ``
- **Code references**:
  - `backend/services/billing/invoiceService.js:L36–L279` (process.env)

### `BLOCKLIST_INGEST_TOKEN`

- **Templates**:
  - `.env.example:219` = `<REPLACE_ME>`
  - `backend/.env.example:188` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/blocklist.js:L38` (process.env)

### `BRAVE_BUDGET_ENABLED`

- **Templates**:
  - `.env.example:220` = ``
  - `backend/.env.example:189` = ``
- **Code references**:
  - `backend/services/yana/braveBudget.js:L40` (process.env)
  - `backend/tests/braveBudget.test.js:L110` (process.env)

### `BRAVE_BUDGET_MIN_DAILY`

- **Templates**:
  - `.env.example:221` = ``
  - `backend/.env.example:190` = ``
- **Code references**:
  - `backend/services/yana/braveBudget.js:L49` (process.env)
  - `backend/tests/braveBudget.test.js:L69–L84` (process.env)

### `BRAVE_MONTHLY_QUERY_BUDGET`

- **Templates**:
  - `.env.example:222` = ``
  - `backend/.env.example:191` = ``
- **Code references**:
  - `backend/services/yana/braveBudget.js:L44` (process.env)
  - `backend/tests/braveBudget.test.js:L68–L96` (process.env)

### `BRAVE_SEARCH_API_KEY`

- **Templates**:
  - `.env.example:223` = `<REPLACE_ME>`
  - `backend/.env.example:192` = `<REPLACE_ME>`
- **Code references**:
  - `backend/server.js:L3163` (process.env)
  - `backend/services/searchProviderHealth.js:L109` (process.env)
  - `backend/services/shared/webSearchEngine.js:L121` (process.env)
  - `backend/services/yana/webSearchProvider.js:L53` (process.env)
  - `backend/tests/searchProviderHealth.test.js:L40–L127` (process.env)
  - `backend/tests/webSearchEngine.test.js:L73–L463` (process.env)

### `BROADCAST_FROM_EMAIL`

- **Templates**:
  - `.env.example:224` = ``
  - `backend/.env.example:193` = ``
- **Code references**:
  - `backend/services/comms/commsService.js:L37` (process.env)

### `BUILD_TIME`

- **Templates**:
  - `.env.example:225` = ``
  - `backend/.env.example:194` = ``
- **Code references**:
  - `backend/routes/version.js:L39` (process.env)

### `BUILD_TIMESTAMP`

- **Templates**:
  - `.env.example:226` = ``
  - `backend/.env.example:195` = ``
- **Code references**:
  - `backend/server.js:L2797` (process.env)

### `BULK_POPULATE_KEY`

- **Templates**:
  - `.env.example:227` = `<REPLACE_ME>`
  - `backend/.env.example:196` = `<REPLACE_ME>`
- **Code references**:
  - `backend/middleware/authIdentity.js:L55` (process.env)
  - `backend/routes/authMe.js:L288` (process.env)
  - `backend/routes/crawlerV2.js:L8` (process.env)
  - `backend/routes/crawlers.js:L1714–L2473` (process.env)
  - `backend/server.js:L1631–L1909` (process.env)
  - `tests/unit/authIdentity.test.mjs:L93–L162` (process.env)

### `CATALOG_RESCORE_PAIR_BUDGET`

- **Templates**:
  - `.env.example:228` = ``
  - `backend/.env.example:197` = ``
- **Code references**:
  - `backend/services/matching/catalogRescoreSweep.js:L167` (process.env)

### `CATALOG_RESCORE_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:229` = ``
  - `backend/.env.example:198` = ``
- **Code references**:
  - `backend/services/matching/catalogRescoreSweep.js:L169` (process.env)

### `CENSUS_GEO_TIMEOUT_MS`

- **Templates**:
  - `.env.example:230` = ``
  - `backend/.env.example:199` = ``
- **Code references**:
  - `backend/services/verification/verificationConfig.js:L56` (env helper)

### `CI`

- **Templates**:
  - `.env.example:231` = ``
  - `backend/.env.example:200` = ``
- **Code references**:
  - `scripts/ensure-build-natives.mjs:L89` (process.env)
  - `tests/e2e/playwright.config.mjs:L19–L33` (process.env)
  - `tests/smoke/playwright.config.mjs:L12–L25` (process.env)

### `CLOUD_LOGIN_KEYFRAME_MS`

- **Templates**:
  - `.env.example:232` = ``
  - `backend/.env.example:201` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonCloudLogin.js:L96` (process.env)

### `CODEQL_SCAN_EVENT`

- **Templates**:
  - `.env.example:233` = ``
  - `backend/.env.example:202` = ``
- **Code references**:
  - `scripts/check-codeql-baseline.mjs:L220` (process.env)

### `CODEQL_SCAN_REPOSITORY`

- **Templates**:
  - `.env.example:234` = ``
  - `backend/.env.example:203` = ``
- **Code references**:
  - `scripts/check-codeql-baseline.mjs:L221` (process.env)

### `CODEQL_SCAN_SHA`

- **Templates**:
  - `.env.example:235` = ``
  - `backend/.env.example:204` = ``
- **Code references**:
  - `scripts/check-codeql-baseline.mjs:L222` (process.env)

### `COMMIT_AUDIT_OUT_PATH`

- **Templates**:
  - `.env.example:236` = ``
  - `backend/.env.example:205` = ``
- **Code references**:
  - `scripts/audit-commits-14d.mjs:L66` (process.env)

### `COMMIT_SHA`

- **Templates**:
  - `.env.example:237` = ``
  - `backend/.env.example:206` = ``
- **Code references**:
  - `backend/routes/health.js:L73–L535` (process.env)
  - `backend/server.js:L2449` (process.env)
  - `backend/startup/backgroundServices.js:L418` (process.env)

### `COMPARABLE_AWARDS`

- **Templates**:
  - `.env.example:238` = ``
  - `backend/.env.example:207` = ``
- **Code references**:
  - `backend/services/comparableAwardsService.js:L26` (process.env)
  - `backend/tests/comparableAwards.test.js:L42–L174` (process.env)

### `COMPREHENSIVE_GEO_JOB_TIMEOUT_MS`

- **Templates**:
  - `.env.example:239` = ``
  - `backend/.env.example:208` = ``
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L88` (process.env)
  - `backend/services/dataReadinessService.js:L156` (process.env)

### `COMPREHENSIVE_JOB_TIMEOUT_MS`

- **Templates**:
  - `.env.example:240` = ``
  - `backend/.env.example:209` = ``
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L78` (process.env)

### `COMPREHENSIVE_TEST_ADMIN_EMAIL`

- **Templates**:
  - `.env.example:241` = ``
  - `backend/.env.example:210` = ``
- **Code references**:
  - `scripts/comprehensive-app-test.mjs:L40` (env helper)

### `COMPREHENSIVE_TEST_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:242` = `<REPLACE_ME>`
  - `backend/.env.example:211` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/comprehensive-app-test.mjs:L39` (env helper)

### `COMPREHENSIVE_TEST_API_BASE`

- **Templates**:
  - `.env.example:243` = ``
  - `backend/.env.example:212` = ``
- **Code references**:
  - `scripts/comprehensive-app-test.mjs:L22` (env helper)

### `COMPREHENSIVE_TEST_CONFIRM`

- **Templates**:
  - `.env.example:244` = ``
  - `backend/.env.example:213` = ``
- **Code references**:
  - `scripts/comprehensive-app-test.mjs:L34` (env helper)

### `COMPREHENSIVE_TEST_CONFIRM_MUTATING_HOST`

- **Templates**:
  - `.env.example:245` = ``
  - `backend/.env.example:214` = ``
- **Code references**:
  - `scripts/comprehensive-app-test.mjs:L30` (env helper)

### `COMPUTERNAME`

- **Templates**:
  - `.env.example:246` = ``
  - `backend/.env.example:215` = ``
- **Code references**:
  - `tools/laptop-connector/scan.js:L122` (process.env)

### `CONFIRM`

- **Templates**:
  - `.env.example:247` = ``
  - `backend/.env.example:216` = ``
- **Code references**:
  - `scripts/godaddy-set-vercel-dns.mjs:L164` (process.env)

### `CONNECTOR_INGEST_MAX_TERMS`

- **Templates**:
  - `.env.example:248` = ``
  - `backend/.env.example:217` = ``
- **Code references**:
  - `backend/services/connectorIngestService.js:L476` (process.env)

### `CORE_TIMEOUT_MINUTES`

- **Templates**:
  - `.env.example:249` = ``
  - `backend/.env.example:218` = ``
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L187` (process.env)

### `CORS_ORIGIN`

- **Templates**:
  - `.env.example:250` = ``
  - `backend/.env.example:219` = ``
- **Code references**:
  - `backend/routes/auth.js:L279` (process.env)
  - `scripts/doctor.mjs:L80` (process.env)
  - `tests/helpers/backendHarness.mjs:L83` (process.env)
  - `tests/unit/anya-background-reply.test.mjs:L47` (process.env)
  - `tests/unit/anya-tasks.test.mjs:L57` (process.env)
  - `tests/unit/api-contracts.test.mjs:L78` (process.env)

### `COUNTRIES`

- **Templates**:
  - `.env.example:251` = ``
  - `backend/.env.example:220` = ``
- **Code references**:
  - `scripts/run-geocrawl-all-zips.mjs:L26–L27` (process.env)

### `COUNTY_FUNDING_CRAWLER_ENABLED`

- **Templates**:
  - `.env.example:252` = ``
  - `backend/.env.example:221` = ``
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L31` (process.env)
  - `tests/unit/county-crawler-honest-directory.test.mjs:L7–L35` (process.env)

### `COVERAGE_AUTOHEAL_ENABLED`

- **Templates**:
  - `.env.example:253` = ``
  - `backend/.env.example:222` = ``
- **Code references**:
  - `backend/services/coverageAudit/profileResultCoverageAudit.js:L469` (process.env)

### `COVERAGE_AUTOHEAL_MAX`

- **Templates**:
  - `.env.example:254` = ``
  - `backend/.env.example:223` = ``
- **Code references**:
  - `backend/services/coverageAudit/profileResultCoverageAudit.js:L485` (process.env)

### `CRAWLER_BROWSER_HEADERS`

- **Templates**:
  - `.env.example:255` = ``
  - `backend/.env.example:224` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L134` (process.env)

### `CRAWLER_COVERAGE_FAILURE_THRESHOLD`

- **Templates**:
  - `.env.example:256` = ``
  - `backend/.env.example:225` = ``
- **Code references**:
  - `backend/services/sam/samRegistry.js:L2703` (process.env)

### `CRAWLER_COVERAGE_WINDOW_HOURS`

- **Templates**:
  - `.env.example:257` = ``
  - `backend/.env.example:226` = ``
- **Code references**:
  - `backend/services/sam/samRegistry.js:L2712` (process.env)

### `CRAWLER_DATA_DIR`

- **Templates**:
  - `.env.example:258` = ``
  - `backend/.env.example:227` = ``
- **Code references**:
  - `backend/scripts/populate-geo-coverage.mjs:L62–L63` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L20–L22` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L24–L25` (process.env)
  - `backend/scripts/run-geo-profile-zips.mjs:L13–L14` (process.env)
  - `backend/services/comprehensiveCrawlerOptimized.js:L46–L600` (process.env)
  - `backend/services/crawlerDispatcher.js:L36–L37` (process.env)
  - `backend/tests/testServer.js:L21` (process.env)
  - `tests/e2e/playwright.config.mjs:L11` (process.env)

### `CRAWLER_DISPATCH_BASE_DELAY_MS`

- **Templates**:
  - `.env.example:259` = ``
  - `backend/.env.example:228` = ``
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L214` (process.env)

### `CRAWLER_DISPATCH_MAX_ATTEMPTS`

- **Templates**:
  - `.env.example:260` = ``
  - `backend/.env.example:229` = ``
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L210` (process.env)

### `CRAWLER_DISPATCH_MAX_DELAY_MS`

- **Templates**:
  - `.env.example:261` = ``
  - `backend/.env.example:230` = ``
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L215` (process.env)

### `CRAWLER_FETCH_TIMEOUT_MS`

- **Templates**:
  - `.env.example:262` = ``
  - `backend/.env.example:231` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L112` (process.env)

### `CRAWLER_FLOOR`

- **Templates**:
  - `.env.example:263` = ``
  - `backend/.env.example:232` = ``
- **Code references**:
  - `scripts/crawler-run.mjs:L17` (process.env)

### `CRAWLER_GAP_LEARNING_ENABLED`

- **Templates**:
  - `.env.example:264` = ``
  - `backend/.env.example:233` = ``
- **Code references**:
  - `backend/services/coverageAudit/liveCrawlGapLearning.js:L64` (process.env)
  - `backend/tests/liveCrawlGapLearning.test.js:L181–L339` (process.env)

### `CRAWLER_JOB_STUCK_THRESHOLD_MS`

- **Templates**:
  - `.env.example:265` = ``
  - `backend/.env.example:234` = ``
- **Code references**:
  - `backend/services/dataReadinessService.js:L159` (process.env)

### `CRAWLER_JOB_TIMEOUT_MS`

- **Templates**:
  - `.env.example:266` = ``
  - `backend/.env.example:235` = ``
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L65` (process.env)

### `CRAWLER_MAX_CONCURRENCY`

- **Templates**:
  - `.env.example:267` = ``
  - `backend/.env.example:236` = ``
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L205` (process.env)

### `CRAWLER_MAX_RETRY_DELAY`

- **Templates**:
  - `.env.example:268` = ``
  - `backend/.env.example:237` = ``
- **Code references**:
  - `backend/services/jobBackpressure.js:L25` (process.env)

### `CRAWLER_MAX_SOURCES`

- **Templates**:
  - `.env.example:269` = ``
  - `backend/.env.example:238` = ``
- **Code references**:
  - `scripts/crawler-doctor.mjs:L143` (process.env)

### `CRAWLER_MIN_FLOOR`

- **Templates**:
  - `.env.example:270` = ``
  - `backend/.env.example:239` = ``
- **Code references**:
  - `scripts/crawler-run.mjs:L17` (process.env)

### `CRAWLER_OS_ALLOW_LEGACY`

- **Templates**:
  - `.env.example:271` = ``
  - `backend/.env.example:240` = ``
- **Code references**:
  - `scripts/check-runtime-imports.mjs:L225` (process.env)

### `CRAWLER_PROFILE_ID`

- **Templates**:
  - `.env.example:272` = ``
  - `backend/.env.example:241` = ``
- **Code references**:
  - `scripts/crawler-run.mjs:L15` (process.env)

### `CRAWLER_RETRY_BASE_DELAY`

- **Templates**:
  - `.env.example:273` = ``
  - `backend/.env.example:242` = ``
- **Code references**:
  - `backend/services/jobBackpressure.js:L20` (process.env)

### `CRAWLER_SOURCE_FAILURE_STREAK`

- **Templates**:
  - `.env.example:274` = ``
  - `backend/.env.example:243` = ``
- **Code references**:
  - `backend/services/sam/samRegistry.js:L2778` (process.env)
  - `backend/startup/enforceInvariants.js:L4566` (process.env)

### `CRAWLER_STALE_CLEANUP_INTERVAL_MS`

- **Templates**:
  - `.env.example:275` = ``
  - `backend/.env.example:244` = ``
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L167` (process.env)

### `CRAWLER_STALE_DAYS`

- **Templates**:
  - `.env.example:276` = ``
  - `backend/.env.example:245` = ``
- **Code references**:
  - `backend/routes/crawlerV2.js:L38` (process.env)

### `CRAWLER_STALE_HEARTBEAT_MS`

- **Templates**:
  - `.env.example:277` = ``
  - `backend/.env.example:246` = ``
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L175` (process.env)

### `CRAWLER_STALE_RUNNING_MS`

- **Templates**:
  - `.env.example:278` = ``
  - `backend/.env.example:247` = ``
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L166` (process.env)
  - `backend/services/sam/samRegistry.js:L2655` (process.env)

### `CRAWL_FALLBACK_RESERVE_MS`

- **Templates**:
  - `.env.example:279` = ``
  - `backend/.env.example:248` = ``
- **Code references**:
  - `backend/routes/realCrawlers.js:L88` (process.env)
  - `backend/tests/specificNeedRoute.test.js:L36` (process.env)

### `CRAWL_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:280` = ``
  - `backend/.env.example:249` = ``
- **Code references**:
  - `backend/routes/realCrawlers.js:L81` (process.env)

### `CRAWL_TOTAL_BUDGET_MS`

- **Templates**:
  - `.env.example:281` = ``
  - `backend/.env.example:250` = ``
- **Code references**:
  - `backend/routes/realCrawlers.js:L80` (process.env)
  - `backend/tests/specificNeedRoute.test.js:L35` (process.env)

### `DATABASE_PATH`

- **Templates**:
  - `.env.example:282` = ``
  - `backend/.env.example:251` = ``
- **Code references**:
  - `scripts/audit-section-metadata.mjs:L71` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L43` (process.env)
  - `scripts/fix-malformed-json.mjs:L20` (process.env)
  - `scripts/ingest-grantsgov.mjs:L17` (process.env)
  - `scripts/ingest-usaspending.mjs:L17` (process.env)
  - `scripts/ingest.mjs:L18` (process.env)
  - `scripts/seed-profile-grants.mjs:L46` (process.env)
  - `scripts/seed-real-opportunities.mjs:L22` (process.env)
  - `scripts/verify-nih-reporter-live-ingest.mjs:L34` (process.env)

### `DATABASE_PUBLIC_URL`

- **Templates**:
  - `.env.example:283` = `http://127.0.0.1:8080`
  - `backend/.env.example:252` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L314` (process.env)

### `DATABASE_URL`

- **Templates**:
  - `.env.example:284` = `postgres://USER:PASSWORD@HOST:5432/DBNAME`
  - `backend/.env.example:253` = `postgres://USER:PASSWORD@HOST:5432/DBNAME`
- **Code references**:
  - `backend/db/index.js:L13–L31` (process.env)
  - `backend/scripts/check-opps.mjs:L3` (process.env)
  - `backend/scripts/check-tables.mjs:L3` (process.env)
  - `backend/scripts/cleanup-funding-opportunities.mjs:L27` (process.env)
  - `backend/scripts/db-summary.mjs:L3` (process.env)
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L314` (process.env)
  - `backend/scripts/rekey-dedup-catalog.mjs:L25` (process.env)
  - `backend/scripts/rescore-all-matches.mjs:L23` (process.env)
  - `backend/scripts/score-distribution.mjs:L25` (process.env)
  - `backend/scripts/seed-profile-grants.mjs:L26` (process.env)
  - `backend/scripts/seed-welcome-video.mjs:L82–L101` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L53` (process.env)
  - `scripts/check-db.mjs:L3` (process.env)
  - `scripts/crawler-doctor.mjs:L19` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L24` (process.env)
  - `scripts/prepopulate-profile-grants.mjs:L32` (process.env)
  - `scripts/probe-prod-amount-residual.mjs:L12` (process.env)
  - `scripts/seed-matched-grants.mjs:L32` (process.env)
  - `scripts/seed-profile-grants.mjs:L19` (process.env)
  - `tools/weekly-link-verify.mjs:L27` (process.env)

### `DB_AUTO_MIGRATE`

- **Templates**:
  - `.env.example:285` = ``
  - `backend/.env.example:254` = ``
- **Code references**:
  - `backend/start.js:L43–L52` (process.env)
  - `backend/startup/bootstrap.js:L135` (process.env)
  - `backend/tests/testServer.js:L17` (process.env)

### `DB_DIALECT`

- **Templates**:
  - `.env.example:286` = ``
  - `backend/.env.example:255` = ``
- **Code references**:
  - `backend/db/index.js:L73` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L164` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L6` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L9` (process.env)

### `DB_PATH`

- **Templates**:
  - `.env.example:287` = ``
  - `backend/.env.example:256` = ``
- **Code references**:
  - `backend/services/diagnosticsService.js:L121–L414` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L41` (process.env)
  - `scripts/check-profiles.mjs:L45–L46` (process.env)
  - `scripts/db-opportunity-tag-stats.cjs:L3` (process.env)
  - `scripts/db-term-coverage.cjs:L3` (process.env)
  - `scripts/db-top-tags.cjs:L3` (process.env)
  - `scripts/db-url-stats.cjs:L3` (process.env)
  - `scripts/ensure-admin-user.mjs:L24` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L21` (process.env)
  - `scripts/run-geocrawl-all-zips.mjs:L24` (process.env)
  - `scripts/seed-profiles.mjs:L44–L45` (process.env)

### `DB_POOL_MAX`

- **Templates**:
  - `.env.example:288` = ``
  - `backend/.env.example:257` = ``
- **Code references**:
  - `backend/db/index.js:L601` (process.env)

### `DB_PROVIDER`

- **Templates**:
  - `.env.example:289` = `sqlite`
  - `backend/.env.example:258` = `sqlite`
- **Code references**:
  - `backend/db/index.js:L72` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L164` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L5` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L8` (process.env)

### `DEAD_URL_REPAIR_BOOT_LIMIT`

- **Templates**:
  - `.env.example:290` = ``
  - `backend/.env.example:259` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4739` (process.env)

### `DEAD_URL_REPAIR_COOLDOWN_MS`

- **Templates**:
  - `.env.example:291` = ``
  - `backend/.env.example:260` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4742` (process.env)

### `DEAD_URL_REPAIR_MAX_ATTEMPTS`

- **Templates**:
  - `.env.example:292` = ``
  - `backend/.env.example:261` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4741` (process.env)

### `DEAD_URL_REPAIR_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:293` = ``
  - `backend/.env.example:262` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4740` (process.env)

### `DEDUPE_BASE_URL`

- **Templates**:
  - `.env.example:294` = `http://127.0.0.1:8080`
  - `backend/.env.example:263` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L16` (process.env)
  - `scripts/dedupe-profiles.mjs:L28` (process.env)

### `DEPLOY_ENV`

- **Templates**:
  - `.env.example:295` = ``
  - `backend/.env.example:264` = ``
- **Code references**:
  - `backend/routes/admin.js:L5574` (process.env)
  - `backend/services/anyaAutonomousCrawler.js:L675` (process.env)
  - `backend/services/anyaAutonomousFunctionRunner.js:L30` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L55` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L19` (process.env)
  - `backend/services/anyaTestRepair.js:L14` (process.env)
  - `backend/services/nationalPrograms/audit.js:L12` (process.env)
  - `tests/unit/security-hardening.test.mjs:L43–L68` (process.env)

### `DEPLOY_TIMESTAMP`

- **Templates**:
  - `.env.example:296` = ``
  - `backend/.env.example:265` = ``
- **Code references**:
  - `backend/routes/health.js:L537` (process.env)

### `DESIGNATED_PROFILES_FILE`

- **Templates**:
  - `.env.example:297` = ``
  - `backend/.env.example:266` = ``
- **Code references**:
  - `backend/config/designatedProfiles.js:L411` (process.env)

### `DEV`

- **Templates**: (not present)
- **Code references**:
  - `src/api/client.js:L15` (import.meta.env)
  - `src/components/auth/AuthErrorBoundary.jsx:L93` (import.meta.env)
  - `src/components/shared/ErrorBoundary.jsx:L21` (import.meta.env)
  - `src/components/shared/clickTracer.jsx:L4` (import.meta.env)
  - `src/config/env.js:L31` (import.meta.env)
  - `src/utils/logger.js:L11` (import.meta.env)

### `DIRECT_LAND_TOKEN_TTL_MS`

- **Templates**:
  - `.env.example:298` = `<REPLACE_ME>`
  - `backend/.env.example:267` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/anyaDirectLandToken.js:L30` (process.env)

### `DISABLE_BACKGROUND_SERVICES`

- **Templates**:
  - `.env.example:299` = ``
  - `backend/.env.example:268` = ``
- **Code references**:
  - `backend/server.js:L1436` (process.env)

### `DISABLE_SEEDING`

- **Templates**:
  - `.env.example:300` = ``
  - `backend/.env.example:269` = ``
- **Code references**:
  - `backend/scripts/seed-profile-grants.mjs:L20` (process.env)
  - `backend/utils/seedOnStartup.js:L25` (process.env)
  - `scripts/prepopulate-profile-grants.mjs:L26` (process.env)
  - `scripts/seed-matched-grants.mjs:L26` (process.env)
  - `scripts/seed-profile-grants.mjs:L13` (process.env)
  - `tests/unit/matchDecisionEngine.lifecycle.test.mjs:L468–L479` (process.env)
  - `tests/unit/seed-authority-convergence.test.mjs:L114–L130` (process.env)
  - `tests/unit/strict-matching-discovery.test.mjs:L336–L345` (process.env)

### `DISK_USAGE_WARN_PCT`

- **Templates**:
  - `.env.example:301` = ``
  - `backend/.env.example:270` = ``
- **Code references**:
  - `backend/services/maintenance/diskUsage.js:L40` (process.env)

### `DOMAIN_CORPUS_CRAWL_TIMEOUT_MS`

- **Templates**:
  - `.env.example:302` = ``
  - `backend/.env.example:271` = ``
- **Code references**:
  - `backend/services/crawlers/domainCorpusCrawler.js:L19` (process.env)

### `DRY_RUN`

- **Templates**:
  - `.env.example:303` = ``
  - `backend/.env.example:272` = ``
- **Code references**:
  - `backend/scripts/restore-profile-sections-from-orgs.mjs:L15–L15` (process.env)
  - `scripts/cleanup-all-profiles-pipeline.mjs:L21` (process.env)
  - `scripts/run-pipeline-cleanup-now.mjs:L31` (process.env)
  - `scripts/verify-nih-reporter-live-ingest.mjs:L35` (process.env)

### `E2E_ADMIN_EMAIL`

- **Templates**:
  - `.env.example:304` = ``
  - `backend/.env.example:273` = ``
- **Code references**:
  - `tests/e2e/playwright.config.mjs:L12` (process.env)

### `E2E_BASE_PATH`

- **Templates**:
  - `.env.example:305` = ``
  - `backend/.env.example:274` = ``
- **Code references**:
  - `tests/e2e/playwright.config.mjs:L10` (process.env)

### `E2E_BASE_URL`

- **Templates**:
  - `.env.example:306` = `http://127.0.0.1:8080`
  - `backend/.env.example:275` = `http://127.0.0.1:8080`
- **Code references**:
  - `tests/e2e/playwright.config.mjs:L6` (process.env)

### `E2E_PORT`

- **Templates**:
  - `.env.example:307` = `8080`
  - `backend/.env.example:276` = `8080`
- **Code references**:
  - `tests/e2e/playwright.config.mjs:L4` (process.env)

### `ECF_LIVE_FETCH_TIMEOUT_MS`

- **Templates**:
  - `.env.example:308` = ``
  - `backend/.env.example:277` = ``
- **Code references**:
  - `backend/services/crawlers/ecfBenefitsCrawler.js:L31` (process.env)

### `ECF_LIVE_FETCH_USER_AGENT`

- **Templates**:
  - `.env.example:309` = ``
  - `backend/.env.example:278` = ``
- **Code references**:
  - `backend/services/crawlers/ecfBenefitsCrawler.js:L33` (process.env)

### `EMAIL_FROM`

- **Templates**:
  - `.env.example:310` = ``
  - `backend/.env.example:279` = ``
- **Code references**:
  - `backend/routes/auth.js:L3257–L3361` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L28` (process.env)
  - `backend/services/email.js:L21–L34` (process.env)
  - `backend/services/yanaOutreach/yanaOutreachSafety.js:L97` (env helper)

### `EMAIL_GRANTS_INGEST_TOKEN`

- **Templates**:
  - `.env.example:311` = `<REPLACE_ME>`
  - `backend/.env.example:280` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/emailGrants.js:L34` (process.env)

### `EMAIL_GRANTS_SYNC_CRON`

- **Templates**:
  - `.env.example:312` = ``
  - `backend/.env.example:281` = ``
- **Code references**:
  - `backend/services/emailGrants/emailGrantScheduler.js:L36` (process.env)

### `EMAIL_GRANTS_SYNC_ENABLED`

- **Templates**:
  - `.env.example:313` = ``
  - `backend/.env.example:282` = ``
- **Code references**:
  - `backend/services/emailGrants/emailGrantScheduler.js:L33` (process.env)
  - `backend/services/robert/robertEmailFeedBridge.js:L32` (process.env)
  - `backend/tests/robertCatalogMiner.test.js:L335–L344` (process.env)

### `EMAIL_GRANTS_SYNC_TOP`

- **Templates**:
  - `.env.example:314` = ``
  - `backend/.env.example:283` = ``
- **Code references**:
  - `backend/services/emailGrants/emailGrantScheduler.js:L42` (process.env)
  - `backend/services/robert/robertEmailFeedBridge.js:L36` (process.env)

### `EMAIL_GRANTS_SYNC_TZ`

- **Templates**:
  - `.env.example:315` = ``
  - `backend/.env.example:284` = ``
- **Code references**:
  - `backend/services/emailGrants/emailGrantScheduler.js:L39` (process.env)

### `EMBEDDING_MODEL`

- **Templates**:
  - `.env.example:316` = ``
  - `backend/.env.example:285` = ``
- **Code references**:
  - `backend/services/embeddings/embeddingService.js:L34` (process.env)

### `ENABLE_CENSUS_GEO`

- **Templates**:
  - `.env.example:317` = ``
  - `backend/.env.example:286` = ``
- **Code references**:
  - `backend/services/verification/verificationConfig.js:L46` (env helper)
  - `backend/tests/censusGeo.test.js:L40–L106` (process.env)
  - `vitest.setup.js:L12–L12` (process.env)

### `ENABLE_MIN_NATIONAL_ENSURE`

- **Templates**:
  - `.env.example:318` = ``
  - `backend/.env.example:287` = ``
- **Code references**:
  - `backend/server.js:L1449` (process.env)
  - `backend/startup/selfHeal.js:L267` (process.env)

### `ENABLE_REGISTRY_VERIFICATION`

- **Templates**:
  - `.env.example:319` = ``
  - `backend/.env.example:288` = ``
- **Code references**:
  - `backend/services/verification/verificationConfig.js:L38` (env helper)
  - `backend/tests/nonprofitRegistry.test.js:L44–L132` (process.env)
  - `vitest.setup.js:L11–L11` (process.env)

### `ENFORCE_AMOUNT_ENRICHMENT`

- **Templates**:
  - `.env.example:320` = ``
  - `backend/.env.example:289` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3665` (process.env)
  - `backend/tests/enforceInvariants.test.js:L3921–L3929` (process.env)

### `ENFORCE_AMY_SYNTHETIC_EXPIRY`

- **Templates**:
  - `.env.example:321` = ``
  - `backend/.env.example:290` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5531` (process.env)
  - `backend/tests/enforceInvariants.test.js:L5140–L5226` (process.env)

### `ENFORCE_CANONICAL_PROGRAM_TARGETS`

- **Templates**:
  - `.env.example:322` = ``
  - `backend/.env.example:291` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2370` (process.env)
  - `backend/tests/enforceInvariants.test.js:L2261–L2359` (process.env)

### `ENFORCE_CATALOG_RESCORE`

- **Templates**:
  - `.env.example:323` = ``
  - `backend/.env.example:292` = ``
- **Code references**:
  - `backend/tests/catalogRescoreSweep.test.js:L127–L141` (process.env)

### `ENFORCE_CONDITION_LANE_SCOPE`

- **Templates**:
  - `.env.example:324` = ``
  - `backend/.env.example:293` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L6217` (process.env)
  - `backend/tests/enforceInvariants.test.js:L5851–L5891` (process.env)

### `ENFORCE_COUNTY_CRISIS_RECALL`

- **Templates**:
  - `.env.example:325` = ``
  - `backend/.env.example:294` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L8726` (process.env)
  - `backend/tests/crisisNeedRecall.test.js:L568` (process.env)

### `ENFORCE_DEAD_URL_REPAIR`

- **Templates**:
  - `.env.example:326` = ``
  - `backend/.env.example:295` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4738` (process.env)
  - `backend/tests/enforceInvariants.test.js:L4436–L4450` (process.env)

### `ENFORCE_DECLARED_GEO_SCOPE`

- **Templates**:
  - `.env.example:327` = ``
  - `backend/.env.example:296` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5848` (process.env)
  - `backend/tests/enforceInvariants.test.js:L5312–L5373` (process.env)

### `ENFORCE_DECLARED_PLACE_SCOPE`

- **Templates**:
  - `.env.example:328` = ``
  - `backend/.env.example:297` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L6354` (process.env)
  - `backend/tests/enforceInvariants.test.js:L5552–L5601` (process.env)

### `ENFORCE_FIELD_OF_STUDY_LINK`

- **Templates**:
  - `.env.example:329` = ``
  - `backend/.env.example:298` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L7854` (process.env)
  - `backend/tests/declaredFieldOfStudyRecall.test.js:L303` (process.env)

### `ENFORCE_FOREIGN_JURISDICTION_SCOPE`

- **Templates**:
  - `.env.example:330` = ``
  - `backend/.env.example:299` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L6509` (process.env)
  - `backend/tests/enforceInvariants.test.js:L5313–L6051` (process.env)
  - `backend/tests/nonGrantNoticeSweep.test.js:L87` (process.env)

### `ENFORCE_FUNDER_990_INGEST`

- **Templates**:
  - `.env.example:331` = ``
  - `backend/.env.example:300` = ``
- **Code references**:
  - `backend/services/funderIntel/funder990Ingest.js:L120` (env helper)
  - `backend/tests/funder990Ingest.test.js:L256` (process.env)

### `ENFORCE_FUNDER_BEHAVIOR_RECALL`

- **Templates**:
  - `.env.example:332` = ``
  - `backend/.env.example:301` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L9103` (process.env)
  - `backend/tests/funderBehaviorRecall.test.js:L230` (process.env)

### `ENFORCE_GRANT_AMOUNT_BACKFILL`

- **Templates**:
  - `.env.example:333` = ``
  - `backend/.env.example:302` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2885` (process.env)
  - `backend/tests/enforceInvariants.test.js:L2726–L2733` (process.env)

### `ENFORCE_GRANT_CATALOG_LINK`

- **Templates**:
  - `.env.example:334` = ``
  - `backend/.env.example:303` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3322` (process.env)
  - `backend/tests/enforceInvariants.test.js:L5005–L5014` (process.env)

### `ENFORCE_GRANT_DIRECT_AMOUNT`

- **Templates**:
  - `.env.example:335` = ``
  - `backend/.env.example:304` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4115` (process.env)
  - `backend/tests/enforceInvariants.test.js:L4608–L4714` (process.env)

### `ENFORCE_GRANT_SCORE_BACKFILL`

- **Templates**:
  - `.env.example:336` = ``
  - `backend/.env.example:305` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5230` (process.env)

### `ENFORCE_HAMILTON_STOP_RECHECK`

- **Templates**:
  - `.env.example:337` = ``
  - `backend/.env.example:306` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L1909` (process.env)
  - `backend/tests/enforceInvariants.test.js:L1943–L2088` (process.env)

### `ENFORCE_HAMILTON_TASK_SELF_HEAL`

- **Templates**:
  - `.env.example:338` = ``
  - `backend/.env.example:307` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2007` (process.env)
  - `backend/tests/enforceInvariants.test.js:L1593–L1718` (process.env)

### `ENFORCE_INDIVIDUAL_AMOUNT_CEILING`

- **Templates**:
  - `.env.example:339` = ``
  - `backend/.env.example:308` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L793` (process.env)
  - `backend/tests/enforceInvariants.test.js:L601–L701` (process.env)

### `ENFORCE_INDIVIDUAL_MATCH_CEILING`

- **Templates**:
  - `.env.example:340` = ``
  - `backend/.env.example:309` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L6978` (process.env)
  - `backend/tests/enforceInvariants.test.js:L5314–L5473` (process.env)

### `ENFORCE_INSTITUTION_AID_LINK`

- **Templates**:
  - `.env.example:341` = ``
  - `backend/.env.example:310` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L7364` (process.env)
  - `backend/tests/institutionAidLinkage.test.js:L245–L333` (process.env)

### `ENFORCE_JOHN_DRAFT_PLAUSIBILITY`

- **Templates**:
  - `.env.example:342` = ``
  - `backend/.env.example:311` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5622` (process.env)
  - `backend/tests/enforceJohnDraftPlausibility.test.js:L28–L95` (process.env)

### `ENFORCE_LEAD_CONTACT_PLAUSIBILITY`

- **Templates**:
  - `.env.example:343` = ``
  - `backend/.env.example:312` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5675` (process.env)
  - `backend/tests/yanaEnrichmentPlausibility.test.js:L206–L215` (process.env)

### `ENFORCE_LOCATOR_KIND_CLASSIFICATION`

- **Templates**:
  - `.env.example:344` = ``
  - `backend/.env.example:313` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3486` (process.env)
  - `backend/tests/enforceInvariants.test.js:L4862–L4869` (process.env)

### `ENFORCE_NON_GRANT_NOTICE_SCOPE`

- **Templates**:
  - `.env.example:345` = ``
  - `backend/.env.example:314` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L6668` (process.env)
  - `backend/tests/nonGrantNoticeSweep.test.js:L86–L139` (process.env)

### `ENFORCE_NON_GRANT_PIPELINE`

- **Templates**:
  - `.env.example:346` = ``
  - `backend/.env.example:315` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L6818` (process.env)
  - `backend/tests/enforceInvariants.test.js:L2929–L3025` (process.env)

### `ENFORCE_NO_DANGLING_MATCHES`

- **Templates**:
  - `.env.example:347` = ``
  - `backend/.env.example:316` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2822` (process.env)
  - `backend/tests/enforceInvariants.test.js:L2793–L2801` (process.env)

### `ENFORCE_POINTER_TASK_RECLASS`

- **Templates**:
  - `.env.example:348` = ``
  - `backend/.env.example:317` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L1957` (process.env)
  - `backend/tests/pointerTaskStartupInvariant.test.js:L15–L108` (process.env)

### `ENFORCE_PORTAL_SESSION_LIFETIME`

- **Templates**:
  - `.env.example:349` = ``
  - `backend/.env.example:318` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5361` (process.env)
  - `backend/tests/portalSyncStaleness.test.js:L530–L590` (process.env)

### `ENFORCE_PROFESSION_ELIGIBILITY`

- **Templates**:
  - `.env.example:350` = ``
  - `backend/.env.example:319` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5065` (process.env)
  - `backend/tests/enforceInvariants.test.js:L2893–L2900` (process.env)

### `ENFORCE_PROFILE_DISCOVERY_LINK`

- **Templates**:
  - `.env.example:351` = ``
  - `backend/.env.example:320` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L7591` (process.env)
  - `backend/tests/profileDiscoveryLinkage.test.js:L368` (process.env)

### `ENFORCE_PROFILE_RESULT_FLOOR`

- **Templates**:
  - `.env.example:352` = ``
  - `backend/.env.example:321` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L8130` (process.env)
  - `backend/tests/profileResultFloor.test.js:L423–L435` (process.env)

### `ENFORCE_PROFILE_SCOPED_PIPELINE`

- **Templates**:
  - `.env.example:353` = ``
  - `backend/.env.example:322` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L878–L892` (process.env)
  - `backend/tests/enforceInvariants.test.js:L738–L774` (process.env)

### `ENFORCE_QUALIFIED_PROMOTION`

- **Templates**:
  - `.env.example:354` = ``
  - `backend/.env.example:323` = ``
- **Code references**:
  - `backend/services/pipelinePromotion.js:L264` (process.env)

### `ENFORCE_RELEVANCE_FLOOR`

- **Templates**:
  - `.env.example:355` = ``
  - `backend/.env.example:324` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L638` (process.env)
  - `backend/tests/enforceInvariants.test.js:L484–L1126` (process.env)
  - `backend/tests/studentAidRecall.test.js:L299` (process.env)

### `ENFORCE_SOURCE_URL_SELF_REPAIR`

- **Templates**:
  - `.env.example:356` = ``
  - `backend/.env.example:325` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4561` (process.env)
  - `backend/tests/enforceInvariants.test.js:L4284–L4297` (process.env)

### `ENFORCE_STAGE_OF_LIFE_SCOPE`

- **Templates**:
  - `.env.example:357` = ``
  - `backend/.env.example:326` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L8279` (process.env)
  - `backend/tests/stageOfLifeEligibility.test.js:L506` (process.env)

### `ENFORCE_STALE_MISSING_FIELDS`

- **Templates**:
  - `.env.example:358` = ``
  - `backend/.env.example:327` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L1838` (process.env)
  - `backend/tests/enforceInvariants.test.js:L1788–L1850` (process.env)

### `ENFORCE_STATE_AGENCY_GEO_SCOPE`

- **Templates**:
  - `.env.example:359` = ``
  - `backend/.env.example:328` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5916` (process.env)
  - `backend/tests/enforceInvariants.test.js:L5673–L5732` (process.env)

### `ENFORCE_STATUS_PROVENANCE`

- **Templates**:
  - `.env.example:360` = ``
  - `backend/.env.example:329` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3210` (process.env)
  - `backend/tests/enforceInvariants.test.js:L3484–L3492` (process.env)

### `ENFORCE_STUDENT_AID_ELIGIBILITY`

- **Templates**:
  - `.env.example:361` = ``
  - `backend/.env.example:330` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L1694` (process.env)
  - `backend/tests/enforceInvariants.test.js:L1524–L1532` (process.env)

### `ENFORCE_STUDENT_AID_INSTATE_LINK`

- **Templates**:
  - `.env.example:362` = ``
  - `backend/.env.example:331` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L8440` (process.env)
  - `backend/tests/stageOfLifeEligibility.test.js:L605` (process.env)

### `ENFORCE_SURFACED_MATCH_ELIGIBILITY`

- **Templates**:
  - `.env.example:363` = ``
  - `backend/.env.example:332` = ``
- **Code references**:
  - `backend/services/coverageAudit/surfacedEligibility.js:L155` (process.env)

### `ENFORCE_UNCONFIGURED_PROFILE_SCOPE`

- **Templates**:
  - `.env.example:364` = ``
  - `backend/.env.example:333` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L7178` (process.env)
  - `backend/tests/unconfiguredProfileHonesty.test.js:L369–L466` (process.env)

### `ENFORCE_URL_HYGIENE`

- **Templates**:
  - `.env.example:365` = ``
  - `backend/.env.example:334` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2258` (process.env)
  - `backend/tests/enforceInvariants.test.js:L2141–L2215` (process.env)

### `ENFORCE_URL_RESCUE`

- **Templates**:
  - `.env.example:366` = ``
  - `backend/.env.example:335` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2627` (process.env)
  - `backend/tests/enforceInvariants.test.js:L3277–L3406` (process.env)

### `ENFORCE_VERIFIED_AT_HONESTY`

- **Templates**:
  - `.env.example:367` = ``
  - `backend/.env.example:336` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2465` (process.env)

### `ENFORCE_XMATCH_PRECISION`

- **Templates**:
  - `.env.example:368` = ``
  - `backend/.env.example:337` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L6091` (process.env)
  - `backend/tests/enforceInvariants.test.js:L5760–L5790` (process.env)

### `ERROR_REPORT_EMAIL`

- **Templates**:
  - `.env.example:369` = ``
  - `backend/.env.example:338` = ``
- **Code references**:
  - `backend/services/errorReporter.js:L330` (process.env)
  - `backend/services/firstLoginNotifier.js:L72` (process.env)
  - `backend/tests/firstLoginNotifier.test.js:L99` (process.env)

### `EXPECTED_PATHS`

- **Templates**:
  - `.env.example:370` = ``
  - `backend/.env.example:339` = ``
- **Code references**:
  - `scripts/assert-direct-land-tree.mjs:L19` (process.env)

### `FEATURE_ANYA_TOOLS`

- **Templates**:
  - `.env.example:371` = ``
  - `backend/.env.example:340` = ``
- **Code references**:
  - `backend/config/features.js:L8` (process.env)

### `FEATURE_AUTO_REPAIR`

- **Templates**:
  - `.env.example:372` = ``
  - `backend/.env.example:341` = ``
- **Code references**:
  - `backend/config/features.js:L9` (process.env)

### `FEATURE_CRAWLER_RETRIES`

- **Templates**:
  - `.env.example:373` = ``
  - `backend/.env.example:342` = ``
- **Code references**:
  - `backend/config/features.js:L11` (process.env)
  - `backend/services/crawlerOsService.js:L100` (process.env)

### `FEATURE_DETAILED_MATCHING`

- **Templates**:
  - `.env.example:374` = ``
  - `backend/.env.example:343` = ``
- **Code references**:
  - `backend/config/features.js:L10` (process.env)

### `FEATURE_GEO_CRAWL`

- **Templates**:
  - `.env.example:375` = ``
  - `backend/.env.example:344` = ``
- **Code references**:
  - `backend/config/features.js:L7` (process.env)

### `FIRST_LOGIN_REPORT_EMAIL`

- **Templates**:
  - `.env.example:376` = ``
  - `backend/.env.example:345` = ``
- **Code references**:
  - `backend/services/firstLoginNotifier.js:L71` (process.env)
  - `backend/tests/firstLoginNotifier.test.js:L103` (process.env)

### `FROM_EMAIL`

- **Templates**:
  - `.env.example:377` = ``
  - `backend/.env.example:346` = ``
- **Code references**:
  - `backend/routes/auth.js:L3257–L3361` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L28` (process.env)
  - `backend/services/diagnosticsService.js:L409` (process.env)
  - `backend/services/email.js:L21–L34` (process.env)
  - `backend/services/yanaOutreach/yanaOutreachSafety.js:L97` (env helper)
  - `backend/tests/emailSendHonesty.test.js:L27` (process.env)

### `FRONTEND_BASE_URL`

- **Templates**:
  - `.env.example:378` = `http://127.0.0.1:8080`
  - `backend/.env.example:347` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/routes/auth.js:L202` (process.env)
  - `backend/services/diagnosticsService.js:L416` (process.env)

### `FRONTEND_COMPONENTS_PATH`

- **Templates**:
  - `.env.example:379` = ``
  - `backend/.env.example:348` = ``
- **Code references**:
  - `backend/services/anyaAutonomousFunctionTesting.js:L43` (process.env)

### `FRONTEND_URL`

- **Templates**:
  - `.env.example:380` = `http://127.0.0.1:8080`
  - `backend/.env.example:349` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/stripeService.js:L100` (process.env)

### `FUNDER_990_INGEST_LIMIT`

- **Templates**:
  - `.env.example:381` = ``
  - `backend/.env.example:350` = ``
- **Code references**:
  - `backend/services/funderIntel/funder990Ingest.js:L116` (env helper)

### `FUNDER_990_INGEST_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:382` = ``
  - `backend/.env.example:351` = ``
- **Code references**:
  - `backend/services/funderIntel/funder990Ingest.js:L117` (env helper)

### `FUNDER_990_MAX_ATTEMPTS`

- **Templates**:
  - `.env.example:383` = ``
  - `backend/.env.example:352` = ``
- **Code references**:
  - `backend/services/funderIntel/funder990Ingest.js:L118` (env helper)

### `FUNDER_990_MAX_TX`

- **Templates**:
  - `.env.example:384` = ``
  - `backend/.env.example:353` = ``
- **Code references**:
  - `backend/services/funderIntel/funder990Ingest.js:L119` (env helper)

### `FUNDING_APIS_REQUIRE_KEYS`

- **Templates**:
  - `.env.example:385` = ``
  - `backend/.env.example:354` = ``
- **Code references**:
  - `backend/src/config/apiKeys.js:L80` (process.env)

### `FUNDING_TRACE_MAX_AGE_YEARS`

- **Templates**:
  - `.env.example:386` = ``
  - `backend/.env.example:355` = ``
- **Code references**:
  - `backend/services/fundingTraceService.js:L38` (process.env)

### `FUNDING_TRACE_MIN_AMOUNT`

- **Templates**:
  - `.env.example:387` = ``
  - `backend/.env.example:356` = ``
- **Code references**:
  - `backend/services/fundingTraceService.js:L37` (process.env)

### `GAP_EMAIL_DRAFTS_ENABLED`

- **Templates**:
  - `.env.example:388` = ``
  - `backend/.env.example:357` = ``
- **Code references**:
  - `backend/services/profileGapEmailDrafts.js:L20` (process.env)

### `GEO_BATCH_SIZE`

- **Templates**:
  - `.env.example:389` = ``
  - `backend/.env.example:358` = ``
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L390` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L28` (process.env)

### `GEO_COUNTIES_BY_STATE_PATH`

- **Templates**:
  - `.env.example:390` = ``
  - `backend/.env.example:359` = ``
- **Code references**:
  - `backend/routes/admin.js:L97–L2236` (process.env)
  - `backend/startup/warmCountyCache.js:L50–L51` (process.env)
  - `backend/tests/warmCountyCache.test.js:L16–L22` (process.env)

### `GEO_CRAWL_FIXTURES_DIR`

- **Templates**:
  - `.env.example:391` = ``
  - `backend/.env.example:360` = ``
- **Code references**:
  - `backend/services/comprehensiveCrawlerOptimized.js:L344–L409` (process.env)
  - `backend/services/crawlers/nationalZipCrawler.js:L398` (process.env)

### `GEO_CRAWL_HEARTBEAT_MS`

- **Templates**:
  - `.env.example:392` = ``
  - `backend/.env.example:361` = ``
- **Code references**:
  - `backend/services/crawlers/nationalZipCrawler.js:L1778` (process.env)

### `GEO_MIN_SOURCES_PER_ZIP`

- **Templates**:
  - `.env.example:393` = ``
  - `backend/.env.example:362` = ``
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L391` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L30` (process.env)

### `GEO_MIN_ZIP_COORDINATES`

- **Templates**:
  - `.env.example:394` = ``
  - `backend/.env.example:363` = ``
- **Code references**:
  - `backend/routes/admin.js:L127` (process.env)

### `GEO_RATE_LIMIT_MS`

- **Templates**:
  - `.env.example:395` = ``
  - `backend/.env.example:364` = ``
- **Code references**:
  - `backend/scripts/run-geo-all-us-zips.mjs:L29` (process.env)

### `GEO_RESUME_WINDOW_DAYS`

- **Templates**:
  - `.env.example:396` = ``
  - `backend/.env.example:365` = ``
- **Code references**:
  - `backend/services/crawlers/nationalZipCrawler.js:L1536` (process.env)

### `GEO_SCOPE`

- **Templates**:
  - `.env.example:397` = ``
  - `backend/.env.example:366` = ``
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L293` (process.env)

### `GEO_TIMEOUT_MS`

- **Templates**:
  - `.env.example:398` = ``
  - `backend/.env.example:367` = ``
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L422` (process.env)
  - `backend/scripts/run-geo-all-us-zips.mjs:L74` (process.env)

### `GEO_ZIP_COORDINATES_PATH`

- **Templates**:
  - `.env.example:399` = ``
  - `backend/.env.example:368` = ``
- **Code references**:
  - `backend/routes/admin.js:L93–L94` (process.env)

### `GF_ADMIN_EMAIL`

- **Templates**:
  - `.env.example:400` = ``
  - `backend/.env.example:369` = ``
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L59` (process.env)
  - `scripts/admin-geocrawl-until-complete.mjs:L69` (process.env)

### `GF_ADMIN_PASSWORD`

- **Templates**:
  - `.env.example:401` = `<REPLACE_ME>`
  - `backend/.env.example:370` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L60` (process.env)
  - `scripts/admin-geocrawl-until-complete.mjs:L70` (process.env)

### `GF_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:402` = `<REPLACE_ME>`
  - `backend/.env.example:371` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/admin-geocrawl-until-complete.mjs:L68` (process.env)

### `GF_API`

- **Templates**:
  - `.env.example:403` = ``
  - `backend/.env.example:372` = ``
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L16` (process.env)
  - `scripts/admin-geocrawl-until-complete.mjs:L54` (env helper)
  - `scripts/admin-pipeline-verify-flat.mjs:L13` (process.env)
  - `scripts/admin-process-all-pipelines.mjs:L28` (process.env)
  - `scripts/admin-purge-loan-grants.mjs:L27` (process.env)
  - `scripts/admin-run-student-bridge-funding.mjs:L19` (process.env)

### `GF_CONFIRM_MUTATING_HOST`

- **Templates**:
  - `.env.example:404` = ``
  - `backend/.env.example:373` = ``
- **Code references**:
  - `scripts/admin-geocrawl-until-complete.mjs:L62` (env helper)

### `GF_COUNTRIES`

- **Templates**:
  - `.env.example:405` = ``
  - `backend/.env.example:374` = ``
- **Code references**:
  - `scripts/admin-geocrawl-until-complete.mjs:L79` (process.env)

### `GF_DEDUPE_STRATEGIES`

- **Templates**:
  - `.env.example:406` = ``
  - `backend/.env.example:375` = ``
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L19` (process.env)

### `GF_GRANT_LIMIT`

- **Templates**:
  - `.env.example:407` = ``
  - `backend/.env.example:376` = ``
- **Code references**:
  - `scripts/admin-process-all-pipelines.mjs:L36` (process.env)

### `GF_MAX_WAIT_MS`

- **Templates**:
  - `.env.example:408` = ``
  - `backend/.env.example:377` = ``
- **Code references**:
  - `scripts/admin-process-all-pipelines.mjs:L35` (process.env)

### `GF_POLL_INTERVAL_MS`

- **Templates**:
  - `.env.example:409` = ``
  - `backend/.env.example:378` = ``
- **Code references**:
  - `scripts/admin-process-all-pipelines.mjs:L34` (process.env)

### `GF_TOKEN`

- **Templates**:
  - `.env.example:410` = `<REPLACE_ME>`
  - `backend/.env.example:379` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/admin-dedupe-all-profiles.mjs:L17` (process.env)
  - `scripts/admin-pipeline-verify-flat.mjs:L14` (process.env)
  - `scripts/admin-process-all-pipelines.mjs:L29` (process.env)
  - `scripts/admin-purge-loan-grants.mjs:L28` (process.env)
  - `scripts/admin-run-student-bridge-funding.mjs:L20` (process.env)

### `GITHUB_ACTIONS`

- **Templates**:
  - `.env.example:411` = ``
  - `backend/.env.example:380` = ``
- **Code references**:
  - `scripts/ensure-build-natives.mjs:L91` (process.env)

### `GITHUB_REPO`

- **Templates**:
  - `.env.example:412` = ``
  - `backend/.env.example:381` = ``
- **Code references**:
  - `backend/services/githubSyncVehicles.js:L84` (process.env)

### `GITHUB_TOKEN`

- **Templates**:
  - `.env.example:413` = `<REPLACE_ME>`
  - `backend/.env.example:382` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/githubSyncVehicles.js:L83` (process.env)
  - `backend/tests/anyaOwnerAutonomyTools.test.js:L447–L479` (process.env)

### `GIT_BRANCH`

- **Templates**:
  - `.env.example:414` = ``
  - `backend/.env.example:383` = ``
- **Code references**:
  - `backend/routes/health.js:L536` (process.env)
  - `backend/routes/version.js:L35` (process.env)

### `GIT_COMMIT_SHA`

- **Templates**:
  - `.env.example:415` = ``
  - `backend/.env.example:384` = ``
- **Code references**:
  - `backend/routes/health.js:L72–L535` (process.env)
  - `backend/routes/version.js:L33` (process.env)
  - `backend/server.js:L2448` (process.env)
  - `backend/startup/backgroundServices.js:L417` (process.env)

### `GMAIL_OAUTH_CLIENT_ID`

- **Templates**:
  - `.env.example:416` = ``
  - `backend/.env.example:385` = ``
- **Code references**:
  - `backend/services/blocklist/gmailFilterSyncService.js:L20–L55` (process.env)

### `GMAIL_OAUTH_CLIENT_SECRET`

- **Templates**:
  - `.env.example:417` = `<REPLACE_ME>`
  - `backend/.env.example:386` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/blocklist/gmailFilterSyncService.js:L21–L56` (process.env)

### `GMAIL_OAUTH_REFRESH_TOKEN`

- **Templates**:
  - `.env.example:418` = `<REPLACE_ME>`
  - `backend/.env.example:387` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/blocklist/gmailFilterSyncService.js:L22–L58` (process.env)

### `GODADDY_API_KEY`

- **Templates**:
  - `.env.example:419` = `<REPLACE_ME>`
  - `backend/.env.example:388` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/godaddy-set-vercel-dns.mjs:L45` (env helper)

### `GODADDY_API_SECRET`

- **Templates**:
  - `.env.example:420` = `<REPLACE_ME>`
  - `backend/.env.example:389` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/godaddy-set-vercel-dns.mjs:L46` (env helper)

### `GODADDY_DOMAIN`

- **Templates**:
  - `.env.example:421` = ``
  - `backend/.env.example:390` = ``
- **Code references**:
  - `scripts/godaddy-set-vercel-dns.mjs:L152` (env helper)

### `GOOGLE_API_KEY`

- **Templates**:
  - `.env.example:422` = `<REPLACE_ME>`
  - `backend/.env.example:391` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L84` (process.env)

### `GOOGLE_BUDGET_ENABLED`

- **Templates**:
  - `.env.example:423` = ``
  - `backend/.env.example:392` = ``
- **Code references**:
  - `backend/services/shared/googleBudget.js:L28` (process.env)
  - `backend/tests/googleBudget.test.js:L64–L147` (process.env)

### `GOOGLE_CSE_CX`

- **Templates**:
  - `.env.example:424` = ``
  - `backend/.env.example:393` = ``
- **Code references**:
  - `backend/services/shared/googleCseProvider.js:L31` (process.env)
  - `backend/services/shared/webSearchEngine.js:L72` (process.env)
  - `backend/tests/googleCseProvider.test.js:L37–L59` (process.env)
  - `backend/tests/webSearchEngine.test.js:L76–L581` (process.env)

### `GOOGLE_CSE_DAILY_BUDGET`

- **Templates**:
  - `.env.example:425` = ``
  - `backend/.env.example:394` = ``
- **Code references**:
  - `backend/services/shared/googleBudget.js:L32` (process.env)
  - `backend/tests/googleBudget.test.js:L52–L157` (process.env)

### `GOOGLE_CSE_KEY`

- **Templates**:
  - `.env.example:426` = `<REPLACE_ME>`
  - `backend/.env.example:395` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/shared/googleCseProvider.js:L30` (process.env)
  - `backend/services/shared/webSearchEngine.js:L72` (process.env)
  - `backend/tests/googleCseProvider.test.js:L36–L58` (process.env)
  - `backend/tests/webSearchEngine.test.js:L75–L580` (process.env)

### `GOOGLE_SEARCH_CX`

- **Templates**:
  - `.env.example:427` = ``
  - `backend/.env.example:396` = ``
- **Code references**:
  - `backend/services/countyFundingCrawler.js:L85` (process.env)

### `GRANTFLOW_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:428` = `<REPLACE_ME>`
  - `backend/.env.example:397` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/hamilton-import-chrome-csv.mjs:L33` (process.env)
  - `scripts/hamilton-route-chrome-csv.mjs:L48` (process.env)
  - `scripts/scratch-scholarships-diag.mjs:L4` (process.env)
  - `scripts/smoke-auth-diagnostics.mjs:L13` (process.env)

### `GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS`

- **Templates**:
  - `.env.example:429` = ``
  - `backend/.env.example:398` = ``
- **Code references**:
  - `backend/services/searchProviderHealth.js:L46` (process.env)
  - `backend/services/shared/webSearchEngine.js:L55` (process.env)
  - `backend/tests/webSearchEngine.test.js:L81–L90` (process.env)
  - `tests/unit/web-search-test-isolation.test.mjs:L8–L30` (process.env)

### `GRANTFLOW_API`

- **Templates**:
  - `.env.example:430` = ``
  - `backend/.env.example:399` = ``
- **Code references**:
  - `scripts/hamilton-import-chrome-csv.mjs:L32` (process.env)
  - `scripts/hamilton-route-chrome-csv.mjs:L47` (process.env)

### `GRANTFLOW_API_BASE`

- **Templates**:
  - `.env.example:431` = ``
  - `backend/.env.example:400` = ``
- **Code references**:
  - `scripts/scratch-scholarships-diag.mjs:L3` (process.env)

### `GRANTFLOW_APP_BASE_URL`

- **Templates**:
  - `.env.example:432` = `http://127.0.0.1:8080`
  - `backend/.env.example:401` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/deadlineEmailSmsService.js:L72` (process.env)

### `GRANTFLOW_AUDIT_EMAIL`

- **Templates**:
  - `.env.example:433` = ``
  - `backend/.env.example:402` = ``
- **Code references**:
  - `scripts/production-audit/app-audit.mjs:L232` (env helper)

### `GRANTFLOW_AUDIT_PASSWORD`

- **Templates**:
  - `.env.example:434` = `<REPLACE_ME>`
  - `backend/.env.example:403` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/production-audit/app-audit.mjs:L233` (env helper)

### `GRANTFLOW_BASE_URL`

- **Templates**:
  - `.env.example:435` = `http://127.0.0.1:8080`
  - `backend/.env.example:404` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L35` (process.env)
  - `scripts/verify-crawlers-prod.mjs:L34` (process.env)

### `GRANTFLOW_BEARER_TOKEN`

- **Templates**:
  - `.env.example:436` = `<REPLACE_ME>`
  - `backend/.env.example:405` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L24` (process.env)

### `GRANTFLOW_DISCOVERY_MIN_SCORE`

- **Templates**:
  - `.env.example:437` = ``
  - `backend/.env.example:406` = ``
- **Code references**:
  - `backend/config/matchThresholds.js:L192` (process.env)

### `GRANTFLOW_DISCOVERY_MIN_SCORE_FLOOR`

- **Templates**:
  - `.env.example:438` = ``
  - `backend/.env.example:407` = ``
- **Code references**:
  - `backend/config/matchThresholds.js:L169` (process.env)

### `GRANTFLOW_DRY_RUN`

- **Templates**:
  - `.env.example:439` = ``
  - `backend/.env.example:408` = ``
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L40–L40` (process.env)

### `GRANTFLOW_PROD_AUDIT_DATABASE_URL`

- **Templates**:
  - `.env.example:440` = `http://127.0.0.1:8080`
  - `backend/.env.example:409` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/production-audit/db-audit.mjs:L450` (env helper)

### `GRANTFLOW_PROD_BASE_URL`

- **Templates**:
  - `.env.example:441` = `http://127.0.0.1:8080`
  - `backend/.env.example:410` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/production-audit/app-audit.mjs:L231` (process.env)
  - `scripts/production-audit/db-audit.mjs:L808` (process.env)

### `GRANTFLOW_PROFILE_ID`

- **Templates**:
  - `.env.example:442` = ``
  - `backend/.env.example:411` = ``
- **Code references**:
  - `scripts/verify-crawlers-prod.mjs:L35` (process.env)

### `GRANTFLOW_PROFILE_IDS`

- **Templates**:
  - `.env.example:443` = ``
  - `backend/.env.example:412` = ``
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L38` (process.env)

### `GRANTFLOW_REPO_ROOT`

- **Templates**:
  - `.env.example:444` = ``
  - `backend/.env.example:413` = ``
- **Code references**:
  - `backend/services/missionHealthService.js:L118–L119` (process.env)

### `GRANTFLOW_SCORING_MODEL`

- **Templates**:
  - `.env.example:445` = ``
  - `backend/.env.example:414` = ``
- **Code references**:
  - `backend/config/matchThresholds.js:L61` (process.env)

### `GRANTFLOW_SEED_MODE`

- **Templates**:
  - `.env.example:446` = ``
  - `backend/.env.example:415` = ``
- **Code references**:
  - `backend/server.js:L315` (process.env)
  - `backend/startup/bootstrap.js:L425` (process.env)

### `GRANTFLOW_SIGNIN_URL`

- **Templates**:
  - `.env.example:447` = `http://127.0.0.1:8080`
  - `backend/.env.example:416` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/email.js:L47–L198` (process.env)

### `GRANTFLOW_SKIP_MISSION_GATE`

- **Templates**:
  - `.env.example:448` = ``
  - `backend/.env.example:417` = ``
- **Code references**:
  - `backend/routes/health.js:L463` (process.env)
  - `backend/server.js:L992` (process.env)

### `GRANTFLOW_SKIP_VERIFICATION_GATE`

- **Templates**:
  - `.env.example:449` = ``
  - `backend/.env.example:418` = ``
- **Code references**:
  - `backend/server.js:L313` (process.env)
  - `backend/startup/bootstrap.js:L423` (process.env)

### `GRANTFLOW_TEST_EMAIL`

- **Templates**:
  - `.env.example:450` = ``
  - `backend/.env.example:419` = ``
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L36` (process.env)

### `GRANTFLOW_TEST_PASSWORD`

- **Templates**:
  - `.env.example:451` = `<REPLACE_ME>`
  - `backend/.env.example:420` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L37` (process.env)

### `GRANTFLOW_TEST_RUNNER`

- **Templates**:
  - `.env.example:452` = ``
  - `backend/.env.example:421` = ``
- **Code references**:
  - `backend/services/searchProviderHealth.js:L48` (process.env)
  - `backend/services/shared/searxngProvider.js:L48` (process.env)
  - `backend/services/shared/webSearchCache.js:L60` (process.env)
  - `backend/services/shared/webSearchEngine.js:L57` (process.env)
  - `scripts/run-unit-tests.mjs:L48` (process.env)
  - `scripts/run-vitest-isolated.mjs:L10` (process.env)
  - `tests/unit/web-search-test-isolation.test.mjs:L7–L28` (process.env)
  - `vitest.setup.js:L24–L24` (process.env)

### `GRANTFLOW_TIMEOUT_MS`

- **Templates**:
  - `.env.example:453` = ``
  - `backend/.env.example:422` = ``
- **Code references**:
  - `scripts/smoke-grantflow-mission.mjs:L39` (process.env)

### `GRANTFLOW_TOKEN`

- **Templates**:
  - `.env.example:454` = `<REPLACE_ME>`
  - `backend/.env.example:423` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/verify-crawlers-prod.mjs:L36` (process.env)

### `GRANTS_GOV_API_KEY`

- **Templates**:
  - `.env.example:455` = `<REPLACE_ME>`
  - `backend/.env.example:424` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/diagnosticsService.js:L403` (process.env)
  - `backend/services/grantsDotGovCrawler.js:L21` (process.env)
  - `backend/services/realFundingCrawler.js:L33` (process.env)
  - `backend/services/shared/grantsGovApiClient.js:L20` (process.env)
  - `backend/services/shared/grantsGovClient.js:L38` (process.env)
  - `backend/src/config/apiKeys.js:L47` (env helper)
  - `backend/src/integrations/grantsGov.js:L8` (process.env)

### `GRANT_CATALOG_LINK_LIMIT`

- **Templates**:
  - `.env.example:456` = ``
  - `backend/.env.example:425` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3323` (process.env)

### `GRANT_DIRECT_AMOUNT_BOOT_LIMIT`

- **Templates**:
  - `.env.example:457` = ``
  - `backend/.env.example:426` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4116` (process.env)

### `GRANT_DIRECT_AMOUNT_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:458` = ``
  - `backend/.env.example:427` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4117` (process.env)

### `GRANT_STRUCTURAL_RECLAIM_LIMIT`

- **Templates**:
  - `.env.example:459` = ``
  - `backend/.env.example:428` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4203` (process.env)

### `HAMILTON_ADMIN_EMAIL`

- **Templates**:
  - `.env.example:460` = ``
  - `backend/.env.example:429` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonAdminAccount.js:L27` (process.env)

### `HAMILTON_ADMIN_VAULT_PROFILE_ID`

- **Templates**:
  - `.env.example:461` = ``
  - `backend/.env.example:430` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalCredentialService.js:L582` (process.env)
  - `backend/tests/hamiltonCredentialFallback.test.js:L17` (process.env)
  - `backend/tests/hamiltonPortalAutopilotIdentity.test.js:L20` (process.env)
  - `backend/tests/hamiltonPortalSignupAdapter.test.js:L18` (process.env)
  - `backend/tests/portalAutopilotCobrowseAndMerge.test.js:L20` (process.env)

### `HAMILTON_ALLOW_AUTOSUBMIT`

- **Templates**:
  - `.env.example:462` = ``
  - `backend/.env.example:431` = ``
- **Code references**:
  - `backend/tests/automationPosture.test.js:L74–L87` (process.env)
  - `backend/tests/hamiltonAutoSubmitAuthorizedLeg.test.js:L158–L218` (process.env)
  - `backend/tests/hamiltonConfirmationProof.test.js:L117–L133` (process.env)

### `HAMILTON_AUTOPILOT_MAX_PAGES`

- **Templates**:
  - `.env.example:463` = ``
  - `backend/.env.example:432` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonAutopilotEngine.js:L59` (process.env)

### `HAMILTON_AUTOPILOT_NAV_TIMEOUT_MS`

- **Templates**:
  - `.env.example:464` = ``
  - `backend/.env.example:433` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonAutopilotEngine.js:L57` (process.env)

### `HAMILTON_AUTOPILOT_STEP_TIMEOUT_MS`

- **Templates**:
  - `.env.example:465` = ``
  - `backend/.env.example:434` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonAutopilotEngine.js:L58` (process.env)

### `HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST`

- **Templates**:
  - `.env.example:466` = ``
  - `backend/.env.example:435` = ``
- **Code references**:
  - `backend/tests/hamiltonAutoSubmitAuthorizedLeg.test.js:L157–L166` (process.env)
  - `backend/tests/hamiltonBrowserAutomationGuard.test.js:L17–L52` (process.env)
  - `backend/tests/hamiltonConfirmationProof.test.js:L113–L125` (process.env)
  - `backend/tests/hamiltonControlledBetaBrowserBoundary.test.js:L20–L29` (process.env)
  - `backend/tests/hamiltonDraftPacketBridge.test.js:L303–L308` (process.env)
  - `backend/tests/hamiltonPortalAutopilotIdentity.test.js:L24` (process.env)
  - `backend/tests/hamiltonPortalSignupAdapter.test.js:L48–L53` (process.env)
  - `backend/tests/portalAutopilotCobrowseAndMerge.test.js:L22` (process.env)
  - `backend/tests/portalSyncRequiresSession.test.js:L14` (process.env)

### `HAMILTON_BROWSER_STORAGE_DIR`

- **Templates**:
  - `.env.example:467` = ``
  - `backend/.env.example:436` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonCredentialSessionService.js:L131` (process.env)
  - `tests/unit/hamilton-hard-stop-alerts.test.mjs:L270` (process.env)
  - `tests/unit/hamilton-hard-stop-resolver.test.mjs:L156–L449` (process.env)

### `HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT`

- **Templates**:
  - `.env.example:468` = ``
  - `backend/.env.example:437` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonCloudLogin.js:L113` (process.env)

### `HAMILTON_CLOUD_LOGIN_ENABLED`

- **Templates**:
  - `.env.example:469` = ``
  - `backend/.env.example:438` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonCloudLogin.js:L124` (process.env)

### `HAMILTON_CLOUD_LOGIN_PROVIDER`

- **Templates**:
  - `.env.example:470` = ``
  - `backend/.env.example:439` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonCloudLogin.js:L106` (process.env)
  - `backend/tests/hamiltonCloudLoginInputLifecycle.test.js:L24` (process.env)
  - `backend/tests/hamiltonCloudLoginPopupFollow.test.js:L22` (process.env)
  - `backend/tests/hamiltonCloudLoginSessionSeed.test.js:L29` (process.env)
  - `backend/tests/hamiltonControlledBetaBrowserBoundary.test.js:L21–L30` (process.env)

### `HAMILTON_CONFIRMATION_DIR`

- **Templates**:
  - `.env.example:471` = ``
  - `backend/.env.example:440` = ``
- **Code references**:
  - `backend/tests/hamiltonConfirmationProof.test.js:L116–L131` (process.env)

### `HAMILTON_DECOMPOSE_POINTER_LISTINGS`

- **Templates**:
  - `.env.example:472` = ``
  - `backend/.env.example:441` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonAutomationClassifier.js:L56` (process.env)
  - `backend/services/hamilton/hamiltonFundingSourcePolicy.js:L120` (process.env)
  - `backend/tests/applicationTaskIdentityAndPointerLeads.test.js:L89–L109` (process.env)

### `HAMILTON_ENABLE_BROWSER_AUTOMATION`

- **Templates**:
  - `.env.example:473` = ``
  - `backend/.env.example:442` = ``
- **Code references**:
  - `backend/tests/hamiltonAutoSubmitAuthorizedLeg.test.js:L156–L165` (process.env)
  - `backend/tests/hamiltonBrowserAutomationGuard.test.js:L16–L28` (process.env)
  - `backend/tests/hamiltonConfirmationProof.test.js:L112–L124` (process.env)
  - `backend/tests/hamiltonControlledBetaBrowserBoundary.test.js:L19–L28` (process.env)
  - `backend/tests/hamiltonDraftPacketBridge.test.js:L302–L307` (process.env)
  - `backend/tests/hamiltonPortalAutopilotIdentity.test.js:L23` (process.env)
  - `backend/tests/hamiltonPortalSignupAdapter.test.js:L47–L52` (process.env)
  - `backend/tests/portalAutopilotCobrowseAndMerge.test.js:L21` (process.env)
  - `backend/tests/portalSyncRequiresSession.test.js:L13` (process.env)
  - `tests/unit/hamilton-automation.test.mjs:L417–L508` (process.env)

### `HAMILTON_LISTING_MAX_APPLIES`

- **Templates**:
  - `.env.example:474` = ``
  - `backend/.env.example:443` = ``
- **Code references**:
  - `backend/services/hamilton/listingDecomposition.js:L42` (process.env)

### `HAMILTON_LISTING_MAX_ITEMS`

- **Templates**:
  - `.env.example:475` = ``
  - `backend/.env.example:444` = ``
- **Code references**:
  - `backend/services/hamilton/listingDecomposition.js:L40` (process.env)

### `HAMILTON_PACKET_RETENTION_HOURS`

- **Templates**:
  - `.env.example:476` = ``
  - `backend/.env.example:445` = ``
- **Code references**:
  - `backend/services/maintenance/pruneDiskArtifacts.js:L172` (process.env)

### `HAMILTON_PACKET_STORAGE_DIR`

- **Templates**:
  - `.env.example:477` = ``
  - `backend/.env.example:446` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:L502` (process.env)
  - `backend/services/hamilton/hamiltonFullProposalGenerator.js:L567` (process.env)
  - `backend/services/maintenance/pruneDiskArtifacts.js:L168` (process.env)
  - `backend/tests/hamiltonPacketBilingual.test.js:L46–L50` (process.env)
  - `tests/unit/hamilton-automation.test.mjs:L127` (process.env)

### `HAMILTON_PORTAL_SYNC_MAX_PROMPTS`

- **Templates**:
  - `.env.example:478` = ``
  - `backend/.env.example:447` = ``
- **Code references**:
  - `backend/services/hamilton/portalSyncStaleness.js:L179` (process.env)

### `HAMILTON_PORTAL_SYNC_STALE_DAYS`

- **Templates**:
  - `.env.example:479` = ``
  - `backend/.env.example:448` = ``
- **Code references**:
  - `backend/services/hamilton/portalSyncStaleness.js:L173` (process.env)

### `HAMILTON_PROPOSAL_ANTHROPIC_MODEL`

- **Templates**:
  - `.env.example:480` = ``
  - `backend/.env.example:449` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonFullProposalGenerator.js:L58` (process.env)

### `HAMILTON_RUN_ON_SCHEDULE`

- **Templates**:
  - `.env.example:481` = ``
  - `backend/.env.example:450` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonScheduler.js:L59–L198` (process.env)

### `HAMILTON_SCHEDULE_BATCH_SIZE`

- **Templates**:
  - `.env.example:482` = ``
  - `backend/.env.example:451` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonScheduler.js:L69` (process.env)

### `HAMILTON_SCHEDULE_INTERVAL_MS`

- **Templates**:
  - `.env.example:483` = ``
  - `backend/.env.example:452` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonScheduler.js:L63` (process.env)

### `HAMILTON_SCREENSHOTS_DIR`

- **Templates**:
  - `.env.example:484` = ``
  - `backend/.env.example:453` = ``
- **Code references**:
  - `backend/services/maintenance/pruneDiskArtifacts.js:L155` (process.env)

### `HAMILTON_SCREENSHOT_RETENTION_HOURS`

- **Templates**:
  - `.env.example:485` = ``
  - `backend/.env.example:454` = ``
- **Code references**:
  - `backend/services/maintenance/pruneDiskArtifacts.js:L159` (process.env)

### `HAMILTON_SELF_HEAL_REQUEUE_CAP`

- **Templates**:
  - `.env.example:486` = ``
  - `backend/.env.example:455` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L1793` (process.env)
  - `backend/tests/enforceInvariants.test.js:L1594–L1731` (process.env)

### `HAMILTON_SESSION_KEEPALIVE_HOURS`

- **Templates**:
  - `.env.example:487` = ``
  - `backend/.env.example:456` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonSessionKeepAlive.js:L92` (process.env)

### `HAMILTON_SIGNUP_NAV_TIMEOUT_MS`

- **Templates**:
  - `.env.example:488` = ``
  - `backend/.env.example:457` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalSignupAdapter.js:L67` (process.env)

### `HAMILTON_SIGNUP_STEP_TIMEOUT_MS`

- **Templates**:
  - `.env.example:489` = ``
  - `backend/.env.example:458` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalSignupAdapter.js:L68` (process.env)

### `HAMILTON_SIGNUP_VERIFY_POLL_MS`

- **Templates**:
  - `.env.example:490` = ``
  - `backend/.env.example:459` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalSignupAdapter.js:L73` (process.env)

### `HAMILTON_SIGNUP_VERIFY_WAIT_MS`

- **Templates**:
  - `.env.example:491` = ``
  - `backend/.env.example:460` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalSignupAdapter.js:L72` (process.env)

### `HAMILTON_STOP_RECHECK_LIMIT`

- **Templates**:
  - `.env.example:492` = ``
  - `backend/.env.example:461` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L1910` (process.env)

### `HAMILTON_SUGGEST_MAX_RETRIES`

- **Templates**:
  - `.env.example:493` = ``
  - `backend/.env.example:462` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L125` (process.env)

### `HAMILTON_SUGGEST_MODEL`

- **Templates**:
  - `.env.example:494` = ``
  - `backend/.env.example:463` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L130` (process.env)

### `HAMILTON_SUGGEST_TIMEOUT_MS`

- **Templates**:
  - `.env.example:495` = ``
  - `backend/.env.example:464` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalLoginSuggester.js:L124` (process.env)

### `HAMILTON_SYNC_ON_CAPTURE`

- **Templates**:
  - `.env.example:496` = ``
  - `backend/.env.example:465` = ``
- **Code references**:
  - `backend/routes/hamiltonAutomation.js:L1567` (process.env)

### `HAMILTON_TAILORED_APPROVAL_GATE`

- **Templates**:
  - `.env.example:497` = ``
  - `backend/.env.example:466` = ``
- **Code references**:
  - `backend/services/hamilton/tailoredNarrative.js:L47` (process.env)
  - `backend/tests/automationPosture.test.js:L98` (process.env)
  - `backend/tests/hamiltonAutoSubmitAuthorizedLeg.test.js:L159–L436` (process.env)
  - `backend/tests/hamiltonConfirmationProof.test.js:L114–L127` (process.env)

### `HAMILTON_VAULT_UNLOCK_TTL_MS`

- **Templates**:
  - `.env.example:498` = ``
  - `backend/.env.example:467` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalMasterVault.js:L174` (process.env)

### `HAMILTON_WEEKLY_DIGEST_DELIVERY`

- **Templates**:
  - `.env.example:499` = ``
  - `backend/.env.example:468` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonWeeklyDigest.js:L52` (process.env)
  - `backend/tests/hamiltonWeeklyDigest.test.js:L56–L126` (process.env)

### `HAMILTON_WEEKLY_DIGEST_ENABLED`

- **Templates**:
  - `.env.example:500` = ``
  - `backend/.env.example:469` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonWeeklyDigest.js:L36` (process.env)

### `HAMILTON_WEEKLY_DIGEST_HOUR_ET`

- **Templates**:
  - `.env.example:501` = ``
  - `backend/.env.example:470` = ``
- **Code references**:
  - `backend/server.js:L3930` (process.env)

### `HOSTNAME`

- **Templates**:
  - `.env.example:502` = ``
  - `backend/.env.example:471` = ``
- **Code references**:
  - `tools/laptop-connector/scan.js:L122` (process.env)

### `HOURS_LOOKBACK`

- **Templates**:
  - `.env.example:503` = ``
  - `backend/.env.example:472` = ``
- **Code references**:
  - `scripts/test-auto-merge-workflow.mjs:L10` (process.env)

### `HTTP_KEEPALIVE_TIMEOUT_MS`

- **Templates**:
  - `.env.example:504` = ``
  - `backend/.env.example:473` = ``
- **Code references**:
  - `backend/server.js:L3025` (process.env)

### `INDIVIDUAL_PIPELINE_AMOUNT_CEILING`

- **Templates**:
  - `.env.example:505` = ``
  - `backend/.env.example:474` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L726` (process.env)
  - `backend/tests/enforceInvariants.test.js:L602–L5488` (process.env)

### `INGEST_CONNECTORS`

- **Templates**:
  - `.env.example:506` = ``
  - `backend/.env.example:475` = ``
- **Code references**:
  - `backend/services/comprehensiveCrawlerOptimized.js:L606` (process.env)

### `INSTITUTION_AID_LINK_LIMIT`

- **Templates**:
  - `.env.example:507` = ``
  - `backend/.env.example:476` = ``
- **Code references**:
  - `backend/tests/institutionAidLinkage.test.js:L246` (process.env)

### `INSTITUTION_RUN_RECALL_CANDIDATES`

- **Templates**:
  - `.env.example:508` = ``
  - `backend/.env.example:477` = ``
- **Code references**:
  - `backend/services/matching/institutionRunRecall.js:L85` (env helper)

### `INSTITUTION_RUN_RECALL_LIMIT`

- **Templates**:
  - `.env.example:509` = ``
  - `backend/.env.example:478` = ``
- **Code references**:
  - `backend/services/matching/institutionRunRecall.js:L86` (env helper)

### `INTERNAL_API_URL`

- **Templates**:
  - `.env.example:510` = `http://127.0.0.1:8080`
  - `backend/.env.example:479` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/anyaAdminTools.js:L1330` (process.env)

### `INTERNAL_BASE_URL`

- **Templates**:
  - `.env.example:511` = `http://127.0.0.1:8080`
  - `backend/.env.example:480` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/sam/samDiagnostics.js:L213` (process.env)

### `ITEM_NEED_MIN_SCORE`

- **Templates**:
  - `.env.example:512` = ``
  - `backend/.env.example:481` = ``
- **Code references**:
  - `backend/services/itemNeedSearch.js:L80` (process.env)

### `ITEM_SEARCH_CATALOG_SCAN`

- **Templates**:
  - `.env.example:513` = ``
  - `backend/.env.example:482` = ``
- **Code references**:
  - `backend/services/itemNeedSearch.js:L84` (process.env)

### `ITEM_SEARCH_MAX_ITEMS`

- **Templates**:
  - `.env.example:514` = ``
  - `backend/.env.example:483` = ``
- **Code references**:
  - `backend/services/itemNeedSearch.js:L83` (process.env)

### `ITEM_SEARCH_MAX_RESULTS`

- **Templates**:
  - `.env.example:515` = ``
  - `backend/.env.example:484` = ``
- **Code references**:
  - `backend/services/itemNeedSearch.js:L85` (process.env)

### `ITEM_SUGGESTIONS_PER_PROFILE`

- **Templates**:
  - `.env.example:516` = ``
  - `backend/.env.example:485` = ``
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L153` (process.env)

### `ITEM_WEB_LEAD_MAX_RESULTS`

- **Templates**:
  - `.env.example:517` = ``
  - `backend/.env.example:486` = ``
- **Code references**:
  - `backend/routes/realCrawlers.js:L900` (process.env)

### `ITEM_WEB_LEAD_MIN_NEED_SCORE`

- **Templates**:
  - `.env.example:518` = ``
  - `backend/.env.example:487` = ``
- **Code references**:
  - `backend/routes/realCrawlers.js:L899` (process.env)

### `JOHN_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:519` = `<REPLACE_ME>`
  - `backend/.env.example:488` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/blocklist.js:L35` (process.env)
  - `backend/routes/emailGrants.js:L31` (process.env)
  - `backend/routes/john.js:L73` (process.env)

### `JOHN_AI_DRAFTING`

- **Templates**:
  - `.env.example:520` = ``
  - `backend/.env.example:489` = ``
- **Code references**:
  - `backend/services/john/johnEmailComposerAI.js:L53` (process.env)

### `JOHN_AI_MAX_RETRIES`

- **Templates**:
  - `.env.example:521` = ``
  - `backend/.env.example:490` = ``
- **Code references**:
  - `backend/services/john/johnEmailComposerAI.js:L66` (process.env)

### `JOHN_AI_MODEL`

- **Templates**:
  - `.env.example:522` = ``
  - `backend/.env.example:491` = ``
- **Code references**:
  - `backend/services/john/johnEmailComposerAI.js:L46` (process.env)

### `JOHN_AI_TIMEOUT_MS`

- **Templates**:
  - `.env.example:523` = ``
  - `backend/.env.example:492` = ``
- **Code references**:
  - `backend/services/john/johnEmailComposerAI.js:L65` (process.env)

### `JOHN_ALLOW_PRIMARY_MAILBOX_FALLBACK_DRAFTS`

- **Templates**:
  - `.env.example:524` = ``
  - `backend/.env.example:493` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L110` (env helper)

### `JOHN_ALLOW_SEND`

- **Templates**:
  - `.env.example:525` = ``
  - `backend/.env.example:494` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L54` (env helper)

### `JOHN_DISPLAY_NAME`

- **Templates**:
  - `.env.example:526` = `Annie | GrantFlow`
  - `backend/.env.example:495` = `Annie | GrantFlow`
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L68` (env helper)

### `JOHN_DRAFT_ONLY`

- **Templates**:
  - `.env.example:527` = ``
  - `backend/.env.example:496` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L53` (env helper)

### `JOHN_DRAFT_PLAUSIBILITY_LIMIT`

- **Templates**:
  - `.env.example:528` = ``
  - `backend/.env.example:497` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5623` (process.env)

### `JOHN_ENABLED`

- **Templates**:
  - `.env.example:529` = ``
  - `backend/.env.example:498` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L56` (env helper)

### `JOHN_FROM_ALIAS`

- **Templates**:
  - `.env.example:530` = `Annie@axiombiolabs.org`
  - `backend/.env.example:499` = `Annie@axiombiolabs.org`
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L66` (env helper)

### `JOHN_MAX_DRAFTS_PER_24H`

- **Templates**:
  - `.env.example:531` = ``
  - `backend/.env.example:500` = ``
- **Code references**:
  - `backend/services/agentTelemetry/agentTelemetryAggregator.js:L866` (process.env)
  - `backend/services/john/johnOutreachSafety.js:L78` (env helper)

### `JOHN_MAX_DRAFTS_PER_HOUR`

- **Templates**:
  - `.env.example:532` = ``
  - `backend/.env.example:501` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L80` (env helper)

### `JOHN_MAX_DRAFTS_PER_RUN`

- **Templates**:
  - `.env.example:533` = ``
  - `backend/.env.example:502` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L79` (env helper)

### `JOHN_MAX_ENRICHMENT_DEFERRALS`

- **Templates**:
  - `.env.example:534` = ``
  - `backend/.env.example:503` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L87` (env helper)

### `JOHN_MIN_LEAD_SCORE`

- **Templates**:
  - `.env.example:535` = ``
  - `backend/.env.example:504` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L82` (env helper)

### `JOHN_MODE`

- **Templates**:
  - `.env.example:536` = ``
  - `backend/.env.example:505` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L60` (env helper)

### `JOHN_OPT_OUT_LANGUAGE_REQUIRED`

- **Templates**:
  - `.env.example:537` = ``
  - `backend/.env.example:506` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L93` (env helper)

### `JOHN_PHYSICAL_ADDRESS`

- **Templates**:
  - `.env.example:538` = ``
  - `backend/.env.example:507` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L95` (env helper)
  - `backend/tests/johnOrgResearch.test.js:L93` (process.env)

### `JOHN_PHYSICAL_ADDRESS_REQUIRED`

- **Templates**:
  - `.env.example:539` = ``
  - `backend/.env.example:508` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L94` (env helper)

### `JOHN_PRIMARY_MAILBOX`

- **Templates**:
  - `.env.example:540` = `dr.johnwhite@axiombiolabs.org`
  - `backend/.env.example:509` = `dr.johnwhite@axiombiolabs.org`
- **Code references**:
  - `backend/services/john/johnBounceReconcile.js:L76` (process.env)
  - `backend/services/john/johnOutreachSafety.js:L62` (env helper)
  - `backend/tests/johnBounceReconcile.test.js:L16` (process.env)
  - `backend/tests/robertContactDiscovery.test.js:L72` (process.env)

### `JOHN_PROSPECT_LINK`

- **Templates**:
  - `.env.example:541` = ``
  - `backend/.env.example:510` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L101` (env helper)

### `JOHN_REPLY_TO`

- **Templates**:
  - `.env.example:542` = `Annie@axiombiolabs.org`
  - `backend/.env.example:511` = `Annie@axiombiolabs.org`
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L67` (env helper)

### `JOHN_REQUIRE_ALIAS_REVIEW_IF_FALLBACK`

- **Templates**:
  - `.env.example:543` = ``
  - `backend/.env.example:512` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L114` (env helper)

### `JOHN_REQUIRE_CONTACT_SOURCE`

- **Templates**:
  - `.env.example:544` = ``
  - `backend/.env.example:513` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L90` (env helper)

### `JOHN_REQUIRE_HUMAN_REVIEW`

- **Templates**:
  - `.env.example:545` = ``
  - `backend/.env.example:514` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L76` (env helper)

### `JOHN_REQUIRE_PUBLIC_EVIDENCE`

- **Templates**:
  - `.env.example:546` = ``
  - `backend/.env.example:515` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L89` (env helper)

### `JOHN_REQUIRE_YANA_QUALIFIED`

- **Templates**:
  - `.env.example:547` = ``
  - `backend/.env.example:516` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L88` (env helper)

### `JOHN_RUN_HEALTH_WINDOW_HOURS`

- **Templates**:
  - `.env.example:548` = ``
  - `backend/.env.example:517` = ``
- **Code references**:
  - `backend/services/sam/samRegistry.js:L2136` (process.env)

### `JOHN_RUN_ON_SCHEDULE`

- **Templates**:
  - `.env.example:549` = ``
  - `backend/.env.example:518` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L58` (env helper)

### `JOHN_RUN_ON_STARTUP`

- **Templates**:
  - `.env.example:550` = ``
  - `backend/.env.example:519` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L57` (env helper)

### `JOHN_SCHEDULE`

- **Templates**:
  - `.env.example:551` = ``
  - `backend/.env.example:520` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L59` (env helper)

### `JOHN_SUPPRESSION_ENABLED`

- **Templates**:
  - `.env.example:552` = ``
  - `backend/.env.example:521` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L92` (env helper)

### `JOHN_TEST_RECIPIENT`

- **Templates**:
  - `.env.example:553` = ``
  - `backend/.env.example:522` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L105` (env helper)

### `JOHN_WEB_RESEARCH`

- **Templates**:
  - `.env.example:554` = ``
  - `backend/.env.example:523` = ``
- **Code references**:
  - `backend/services/john/johnOrgResearch.js:L27` (process.env)
  - `backend/tests/johnOrgResearch.test.js:L94–L147` (process.env)

### `JWT_SECRET`

- **Templates**:
  - `.env.example:555` = `<REPLACE_ME>`
  - `backend/.env.example:524` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/authMe.js:L284` (process.env)
  - `backend/routes/health.js:L102` (process.env)
  - `backend/server.js:L1589–L1905` (process.env)
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

- **Templates**:
  - `.env.example:556` = ``
  - `backend/.env.example:525` = ``
- **Code references**:
  - `tools/laptop-connector/capture.js:L145` (process.env)
  - `tools/laptop-connector/scan.js:L101` (process.env)

### `LAPTOP_CONNECTOR_MAX_RETRIES`

- **Templates**:
  - `.env.example:557` = ``
  - `backend/.env.example:526` = ``
- **Code references**:
  - `backend/services/laptopConnector/laptopAnalyzer.js:L35` (process.env)

### `LAPTOP_CONNECTOR_MAX_TEXT`

- **Templates**:
  - `.env.example:558` = ``
  - `backend/.env.example:527` = ``
- **Code references**:
  - `backend/services/laptopConnector/laptopAnalyzer.js:L169` (process.env)

### `LAPTOP_CONNECTOR_MODEL`

- **Templates**:
  - `.env.example:559` = ``
  - `backend/.env.example:528` = ``
- **Code references**:
  - `backend/services/laptopConnector/laptopAnalyzer.js:L40` (process.env)

### `LAPTOP_CONNECTOR_TIMEOUT_MS`

- **Templates**:
  - `.env.example:560` = ``
  - `backend/.env.example:529` = ``
- **Code references**:
  - `backend/services/laptopConnector/laptopAnalyzer.js:L34` (process.env)

### `LAPTOP_CONNECTOR_TOKEN`

- **Templates**:
  - `.env.example:561` = `<REPLACE_ME>`
  - `backend/.env.example:530` = `<REPLACE_ME>`
- **Code references**:
  - `tools/laptop-connector/capture.js:L146` (process.env)
  - `tools/laptop-connector/scan.js:L102` (process.env)

### `LARRY_ENABLED`

- **Templates**:
  - `.env.example:562` = ``
  - `backend/.env.example:531` = ``
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L18–L184` (process.env)

### `LARRY_RUN_ON_SCHEDULE`

- **Templates**:
  - `.env.example:563` = ``
  - `backend/.env.example:532` = ``
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L33–L151` (process.env)

### `LARRY_RUN_ON_STARTUP`

- **Templates**:
  - `.env.example:564` = ``
  - `backend/.env.example:533` = ``
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L34–L185` (process.env)

### `LEAD_CONTACT_PLAUSIBILITY_LIMIT`

- **Templates**:
  - `.env.example:565` = ``
  - `backend/.env.example:534` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5676` (process.env)

### `LEGACY_GRANT_ONLY_EXCLUDES_MATCHING`

- **Templates**:
  - `.env.example:566` = ``
  - `backend/.env.example:535` = ``
- **Code references**:
  - `backend/routes/opportunities.js:L282` (process.env)

### `LIMIT`

- **Templates**:
  - `.env.example:567` = ``
  - `backend/.env.example:536` = ``
- **Code references**:
  - `backend/scripts/repair-profile-ownership.mjs:L168` (process.env)
  - `backend/scripts/restore-profile-sections-from-orgs.mjs:L16–L16` (process.env)
  - `scripts/db-top-tags.cjs:L5` (process.env)

### `LIMIT_OPPS_PER_PROFILE`

- **Templates**:
  - `.env.example:568` = ``
  - `backend/.env.example:537` = ``
- **Code references**:
  - `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs:L29` (process.env)

### `LINK_VERIFICATION_BATCH`

- **Templates**:
  - `.env.example:569` = ``
  - `backend/.env.example:538` = ``
- **Code references**:
  - `backend/server.js:L3768–L3871` (process.env)

### `LINK_VERIFICATION_INTERVAL_MS`

- **Templates**:
  - `.env.example:570` = ``
  - `backend/.env.example:539` = ``
- **Code references**:
  - `backend/server.js:L3766` (process.env)

### `LLM_TIMEOUT_MS`

- **Templates**:
  - `.env.example:571` = ``
  - `backend/.env.example:540` = ``
- **Code references**:
  - `backend/utils/llmTimeout.js:L17` (process.env)

### `LOCATOR_KIND_BOOT_LIMIT`

- **Templates**:
  - `.env.example:572` = ``
  - `backend/.env.example:541` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L3487` (process.env)

### `LOG_BUFFER_SIZE`

- **Templates**:
  - `.env.example:574` = ``
  - `backend/.env.example:543` = ``
- **Code references**:
  - `backend/utils/logger.js:L51` (process.env)

### `LOG_LEVEL`

- **Templates**:
  - `.env.example:575` = ``
  - `backend/.env.example:544` = ``
- **Code references**:
  - `backend/utils/logger.js:L25` (process.env)

### `MAINTENANCE_ESTIMATED_MINUTES`

- **Templates**:
  - `.env.example:576` = ``
  - `backend/.env.example:545` = ``
- **Code references**:
  - `backend/services/maintenance/maintenanceMode.js:L25` (process.env)

### `MAINTENANCE_GRACE_MINUTES`

- **Templates**:
  - `.env.example:577` = ``
  - `backend/.env.example:546` = ``
- **Code references**:
  - `backend/services/maintenance/maintenanceMode.js:L24` (process.env)

### `MAINTENANCE_STALE_BUFFER_MINUTES`

- **Templates**:
  - `.env.example:578` = ``
  - `backend/.env.example:547` = ``
- **Code references**:
  - `backend/services/maintenance/maintenanceMode.js:L114` (process.env)

### `MAINTENANCE_STALE_HARD_MAX_MINUTES`

- **Templates**:
  - `.env.example:579` = ``
  - `backend/.env.example:548` = ``
- **Code references**:
  - `backend/services/maintenance/maintenanceMode.js:L117` (process.env)

### `MAIN_DB_PATH`

- **Templates**:
  - `.env.example:580` = ``
  - `backend/.env.example:549` = ``
- **Code references**:
  - `scripts/verification/profiles-integrity.mjs:L15` (process.env)

### `MATCHING_ENGINE_FACET_DEBUG`

- **Templates**:
  - `.env.example:581` = ``
  - `backend/.env.example:550` = ``
- **Code references**:
  - `backend/services/matchEngine.js:L67` (process.env)

### `MATCH_SCOPE_PURGE_LIMIT`

- **Templates**:
  - `.env.example:582` = ``
  - `backend/.env.example:551` = ``
- **Code references**:
  - `backend/tests/enforceInvariants.test.js:L5954–L5972` (process.env)

### `MATCH_THRESHOLD`

- **Templates**:
  - `.env.example:583` = ``
  - `backend/.env.example:552` = ``
- **Code references**:
  - `backend/scripts/backfill-profile-pipeline-from-opportunities.mjs:L28` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L152` (process.env)

### `MAX_CONCURRENT_CRAWLERS`

- **Templates**:
  - `.env.example:584` = ``
  - `backend/.env.example:553` = ``
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L18` (process.env)
  - `backend/services/crawlerDispatcher.js:L205` (process.env)

### `MAX_CRAWLER_RETRIES`

- **Templates**:
  - `.env.example:585` = ``
  - `backend/.env.example:554` = ``
- **Code references**:
  - `backend/services/jobBackpressure.js:L15` (process.env)

### `MAX_EXPORT_ROWS`

- **Templates**:
  - `.env.example:586` = ``
  - `backend/.env.example:555` = ``
- **Code references**:
  - `backend/routes/opportunities.js:L1136` (process.env)

### `MAX_LIMIT`

- **Templates**:
  - `.env.example:587` = ``
  - `backend/.env.example:556` = ``
- **Code references**:
  - `backend/routes/opportunities.js:L426` (process.env)

### `MAX_ORPHAN_AUTO_RETRIES`

- **Templates**:
  - `.env.example:588` = ``
  - `backend/.env.example:557` = ``
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L24` (process.env)

### `MAX_ORPHAN_RETRY_AGE_MS`

- **Templates**:
  - `.env.example:589` = ``
  - `backend/.env.example:558` = ``
- **Code references**:
  - `backend/services/crawlerConcurrencyGuard.js:L35` (process.env)

### `MAX_OWNED_PROFILES`

- **Templates**:
  - `.env.example:590` = ``
  - `backend/.env.example:559` = ``
- **Code references**:
  - `backend/routes/profiles.js:L1307` (process.env)
  - `backend/tests/profileCreateIdempotency.test.js:L143–L264` (process.env)

### `MAX_ZIPS`

- **Templates**:
  - `.env.example:591` = ``
  - `backend/.env.example:560` = ``
- **Code references**:
  - `scripts/run-geocrawl-all-zips.mjs:L25–L25` (process.env)

### `MICROSOFT_CLIENT_ID`

- **Templates**:
  - `.env.example:592` = ``
  - `backend/.env.example:561` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L120` (env helper)
  - `backend/tests/robertContactDiscovery.test.js:L70` (process.env)

### `MICROSOFT_CLIENT_SECRET`

- **Templates**:
  - `.env.example:593` = `<REPLACE_ME>`
  - `backend/.env.example:562` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L121` (env helper)
  - `backend/tests/robertContactDiscovery.test.js:L71` (process.env)

### `MICROSOFT_GRAPH_SCOPES`

- **Templates**:
  - `.env.example:594` = ``
  - `backend/.env.example:563` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L123` (env helper)

### `MICROSOFT_REDIRECT_URI`

- **Templates**:
  - `.env.example:595` = ``
  - `backend/.env.example:564` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L122` (env helper)

### `MICROSOFT_TENANT_ID`

- **Templates**:
  - `.env.example:596` = ``
  - `backend/.env.example:565` = ``
- **Code references**:
  - `backend/services/john/johnOutreachSafety.js:L119` (env helper)
  - `backend/tests/robertContactDiscovery.test.js:L69` (process.env)

### `MIGRATE_ASSERT_FRESH`

- **Templates**:
  - `.env.example:597` = ``
  - `backend/.env.example:566` = ``
- **Code references**:
  - `backend/start.js:L117–L117` (process.env)

### `MIGRATE_VERIFY_COUNTS`

- **Templates**:
  - `.env.example:598` = ``
  - `backend/.env.example:567` = ``
- **Code references**:
  - `backend/start.js:L118–L118` (process.env)

### `MIN_NATIONAL_OPPORTUNITIES`

- **Templates**:
  - `.env.example:599` = ``
  - `backend/.env.example:568` = ``
- **Code references**:
  - `backend/server.js:L1445` (process.env)
  - `backend/startup/selfHeal.js:L261` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L139` (process.env)

### `MIN_NATIONAL_VISIBLE`

- **Templates**:
  - `.env.example:600` = ``
  - `backend/.env.example:569` = ``
- **Code references**:
  - `backend/routes/opportunities.js:L606` (process.env)
  - `scripts/opportunities-national-minimum.mjs:L86` (process.env)

### `MISSION_READINESS_CACHE_MS`

- **Templates**:
  - `.env.example:601` = ``
  - `backend/.env.example:570` = ``
- **Code references**:
  - `backend/routes/health.js:L22` (process.env)

### `MODE`

- **Templates**: (not present)
- **Code references**:
  - `src/utils/logger.js:L12` (import.meta.env)
  - `src/utils/observability.js:L26` (import.meta.env)

### `MONDAY_PORTAL_REMINDER_ENABLED`

- **Templates**:
  - `.env.example:602` = ``
  - `backend/.env.example:571` = ``
- **Code references**:
  - `backend/services/hamilton/mondayPortalReminder.js:L48` (process.env)

### `MONDAY_PORTAL_REMINDER_HOUR_ET`

- **Templates**:
  - `.env.example:603` = ``
  - `backend/.env.example:572` = ``
- **Code references**:
  - `backend/server.js:L3974` (process.env)

### `NAME`

- **Templates**:
  - `.env.example:604` = ``
  - `backend/.env.example:573` = ``
- **Code references**:
  - `backend/services/sam/samRegistry.js:L230` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_ENABLED`

- **Templates**:
  - `.env.example:605` = ``
  - `backend/.env.example:574` = ``
- **Code references**:
  - `backend/server.js:L4274` (process.env)
  - `backend/services/sam/samRegistry.js:L1969–L2577` (process.env)
  - `backend/startup/backgroundServices.js:L370` (process.env)
  - `backend/tests/samDiscoveryAwareness.test.js:L52–L216` (process.env)
  - `backend/tests/testServer.js:L23` (process.env)

### `NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES`

- **Templates**:
  - `.env.example:606` = ``
  - `backend/.env.example:575` = ``
- **Code references**:
  - `backend/server.js:L4276` (process.env)
  - `backend/startup/backgroundServices.js:L372` (process.env)

### `NATIONAL_PROGRAMS_JOB_WEDGE_MS`

- **Templates**:
  - `.env.example:607` = ``
  - `backend/.env.example:576` = ``
- **Code references**:
  - `backend/services/nationalPrograms/continuousRunner.js:L20` (process.env)

### `NATIONAL_PROGRAMS_MAX_DEPTH`

- **Templates**:
  - `.env.example:608` = ``
  - `backend/.env.example:577` = ``
- **Code references**:
  - `backend/server.js:L4280` (process.env)
  - `backend/startup/backgroundServices.js:L380` (process.env)

### `NATIONAL_PROGRAMS_MAX_URLS`

- **Templates**:
  - `.env.example:609` = ``
  - `backend/.env.example:578` = ``
- **Code references**:
  - `backend/server.js:L4279` (process.env)
  - `backend/startup/backgroundServices.js:L376` (process.env)

### `NEED_FIRST_RETAIN_UNANCHORED`

- **Templates**:
  - `.env.example:610` = ``
  - `backend/.env.example:579` = ``
- **Code references**:
  - `backend/services/matching/needFirstMatchPolicy.js:L136` (process.env)
  - `backend/tests/needFirstMatchPolicy.test.js:L252–L270` (process.env)
  - `backend/tests/persistedNeedFirstEdgeCases.test.js:L50–L79` (process.env)

### `NIGHTLY_AMOUNT_ENRICH_LIMIT`

- **Templates**:
  - `.env.example:611` = ``
  - `backend/.env.example:580` = ``
- **Code references**:
  - `backend/services/maintenance/nightlySweep.js:L172` (process.env)

### `NIGHTLY_AMOUNT_ENRICH_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:612` = ``
  - `backend/.env.example:581` = ``
- **Code references**:
  - `backend/services/maintenance/nightlySweep.js:L173` (process.env)

### `NIGHTLY_MAINTENANCE_ENABLED`

- **Templates**:
  - `.env.example:613` = ``
  - `backend/.env.example:582` = ``
- **Code references**:
  - `backend/services/maintenance/nightlySweep.js:L27` (process.env)

### `NIGHTLY_MAINTENANCE_HOUR_ET`

- **Templates**:
  - `.env.example:614` = ``
  - `backend/.env.example:583` = ``
- **Code references**:
  - `backend/server.js:L4013` (process.env)

### `NIGHTLY_MAINTENANCE_MINUTES`

- **Templates**:
  - `.env.example:615` = ``
  - `backend/.env.example:584` = ``
- **Code references**:
  - `backend/services/maintenance/nightlySweep.js:L37` (process.env)

### `NIGHTLY_MAINTENANCE_USE_WINDOW`

- **Templates**:
  - `.env.example:616` = ``
  - `backend/.env.example:585` = ``
- **Code references**:
  - `backend/services/maintenance/nightlySweep.js:L32` (process.env)
  - `backend/tests/nightlySweepWindow.test.js:L14–L35` (process.env)

### `NIH_LIMIT`

- **Templates**:
  - `.env.example:617` = ``
  - `backend/.env.example:586` = ``
- **Code references**:
  - `scripts/verify-nih-reporter-live-ingest.mjs:L36` (process.env)

### `NIH_TEXT`

- **Templates**:
  - `.env.example:618` = ``
  - `backend/.env.example:587` = ``
- **Code references**:
  - `scripts/verify-nih-reporter-live-ingest.mjs:L37` (process.env)

### `NODE_ENV`

- **Templates**:
  - `.env.example:619` = ``
  - `backend/.env.example:588` = ``
- **Code references**:
  - `backend/config/constants.js:L11` (process.env)
  - `backend/config/env.js:L146–L307` (process.env)
  - `backend/db/index.js:L11–L705` (process.env)
  - `backend/middleware/errorHandler.js:L15` (process.env)
  - `backend/routes/admin.js:L3596–L5574` (process.env)
  - `backend/routes/anya.js:L147–L222` (process.env)
  - `backend/routes/auth.js:L221–L3362` (process.env)
  - `backend/routes/grants.js:L2646–L2749` (process.env)
  - `backend/routes/health.js:L80–L464` (process.env)
  - `backend/routes/nofo.js:L314–L511` (process.env)
  - `backend/routes/onboarding.js:L191–L526` (process.env)
  - `backend/routes/reminders.js:L221–L253` (process.env)
  - `backend/routes/version.js:L36` (process.env)
  - `backend/scripts/seed-deterministic.mjs:L37` (process.env)
  - `backend/scripts/seed-profile-grants.mjs:L19` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L9` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L12` (process.env)
  - `backend/server.js:L201–L4266` (process.env)
  - `backend/services/agentControl/agentControlOrchestrator.js:L170` (process.env)
  - `backend/services/anyaAutonomousCrawler.js:L674` (process.env)
  - `backend/services/anyaAutonomousFunctionRunner.js:L29` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L54` (process.env)
  - `backend/services/anyaAutonomousScheduler.js:L18` (process.env)
  - `backend/services/anyaTestRepair.js:L13–L226` (process.env)
  - `backend/services/avatarCrawler.js:L218` (process.env)
  - `backend/services/comprehensiveCrawlerOptimized.js:L581–L602` (process.env)
  - `backend/services/diagnosticsService.js:L45–L413` (process.env)
  - `backend/services/email.js:L22` (process.env)
  - `backend/services/emailFallback.js:L32` (process.env)
  - `backend/services/hamilton/applicationTaskStore.js:L294` (process.env)
  - `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:L492–L781` (process.env)
  - `backend/services/hamilton/hamiltonAutopilotEngine.js:L821` (process.env)
  - `backend/services/hamilton/hamiltonBlockerStore.js:L110` (process.env)
  - `backend/services/missionHealthService.js:L525` (process.env)
  - `backend/services/nationalPrograms/audit.js:L11` (process.env)
  - `backend/services/orgLogoFetcher.js:L293` (process.env)
  - `backend/services/packetPdf.js:L46–L73` (process.env)
  - `backend/services/productionAuditSnapshot.js:L442` (process.env)
  - `backend/src/config/apiKeys.js:L109` (process.env)
  - `backend/start.js:L44–L53` (process.env)
  - `backend/startup/backgroundServices.js:L222–L579` (process.env)
  - `backend/startup/bootstrap.js:L25–L424` (process.env)
  - `backend/startup/selfHeal.js:L266` (process.env)
  - `backend/tests/adminAnyaRunAutonomousRoute.test.js:L156–L166` (process.env)
  - `backend/tests/anyaAutonomousCrawler.real.test.js:L539–L554` (process.env)
  - `backend/tests/otpLoginRetired.test.js:L68` (process.env)
  - `backend/tests/testServer.js:L11` (process.env)
  - `backend/utils/environment.js:L12–L25` (process.env)
  - `backend/utils/logger.js:L27` (process.env)
  - `backend/utils/observability.js:L28` (process.env)
  - `backend/utils/responseEnvelope.js:L92` (process.env)
  - `backend/utils/seedOnStartup.js:L23` (process.env)
  - `scripts/prepopulate-profile-grants.mjs:L25` (process.env)
  - `scripts/seed-matched-grants.mjs:L25` (process.env)
  - `scripts/seed-profile-grants.mjs:L12` (process.env)
  - `scripts/seed-profiles.mjs:L28` (process.env)
  - `src/components/organizations/PrintableProfile.jsx:L68` (process.env)
  - `tests/e2e/playwright.config.mjs:L33` (process.env)
  - `tests/smoke/playwright.config.mjs:L25` (process.env)
  - `tests/unit/avatar-website-cover.test.mjs:L11` (process.env)
  - `tests/unit/pipeline-source-allowlist.test.mjs:L107–L189` (process.env)
  - `tests/unit/security-hardening.test.mjs:L42–L66` (process.env)
  - `tests/unit/seed-authority-convergence.test.mjs:L113–L128` (process.env)
  - `tests/unit/strict-matching-discovery.test.mjs:L321–L346` (process.env)
  - `tests/unit/web-search-test-isolation.test.mjs:L9–L32` (process.env)

### `NOFO_FETCH_MAX_BYTES`

- **Templates**:
  - `.env.example:620` = ``
  - `backend/.env.example:589` = ``
- **Code references**:
  - `backend/routes/nofo.js:L29` (process.env)

### `NOFO_FETCH_TIMEOUT_MS`

- **Templates**:
  - `.env.example:621` = ``
  - `backend/.env.example:590` = ``
- **Code references**:
  - `backend/routes/nofo.js:L68` (process.env)

### `NOFO_PARSE_MAX_TEXT_CHARS`

- **Templates**:
  - `.env.example:622` = ``
  - `backend/.env.example:591` = ``
- **Code references**:
  - `backend/routes/nofo.js:L28` (process.env)

### `NON_GRANT_PIPELINE_LIMIT`

- **Templates**:
  - `.env.example:623` = ``
  - `backend/.env.example:592` = ``
- **Code references**:
  - `backend/tests/enforceInvariants.test.js:L2930–L3050` (process.env)

### `OCR_PDF_DPI`

- **Templates**:
  - `.env.example:624` = ``
  - `backend/.env.example:593` = ``
- **Code references**:
  - `backend/services/documentIngestion/extractTextWithFallback.js:L100–L106` (process.env)

### `OCR_PDF_MAX_PAGES`

- **Templates**:
  - `.env.example:625` = ``
  - `backend/.env.example:594` = ``
- **Code references**:
  - `backend/services/documentIngestion/extractTextWithFallback.js:L99–L105` (process.env)

### `OCR_PROVIDER`

- **Templates**:
  - `.env.example:626` = ``
  - `backend/.env.example:595` = ``
- **Code references**:
  - `backend/services/documentIngestion/ocr/index.js:L13` (process.env)

### `ONBOARDING_VERIFY_BASE`

- **Templates**:
  - `.env.example:627` = ``
  - `backend/.env.example:596` = ``
- **Code references**:
  - `scripts/verify-onboarding-live.mjs:L16` (process.env)

### `OPENAI_API_KEY`

- **Templates**:
  - `.env.example:628` = `<REPLACE_ME>`
  - `backend/.env.example:597` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/admin.js:L847–L1335` (process.env)
  - `backend/routes/anya.js:L220` (process.env)
  - `backend/scripts/create-profile-from-pdf.mjs:L75` (process.env)
  - `backend/scripts/dispatch-crawlers.mjs:L9` (process.env)
  - `backend/scripts/process-all-jobs.mjs:L9` (process.env)
  - `backend/scripts/process-queue.mjs:L10` (process.env)
  - `backend/services/diagnosticsService.js:L406` (process.env)
  - `backend/tests/applyEnginePortalUrlIntegrity.test.js:L268–L321` (process.env)
  - `backend/tests/profileSectionAiFallback.test.js:L10` (process.env)
  - `backend/utils/openaiClient.js:L29–L55` (process.env)

### `OPENAI_MAX_RETRIES`

- **Templates**:
  - `.env.example:629` = ``
  - `backend/.env.example:598` = ``
- **Code references**:
  - `backend/utils/openaiClient.js:L78` (process.env)

### `OPENAI_MODEL`

- **Templates**:
  - `.env.example:630` = ``
  - `backend/.env.example:599` = ``
- **Code references**:
  - `backend/apply/applyEngine.js:L1483` (process.env)
  - `backend/config/constants.js:L57` (process.env)
  - `backend/routes/admin.js:L54` (process.env)
  - `backend/routes/grants.js:L1025` (process.env)
  - `backend/routes/legacyFunctions.js:L138` (process.env)
  - `backend/routes/nofo.js:L30` (process.env)
  - `backend/routes/profiles.js:L3679–L3890` (process.env)
  - `backend/services/anyaAdversarialRepairLoop.js:L323` (process.env)
  - `backend/services/anyaToolRegistry.js:L3762` (process.env)
  - `backend/services/grantApplicationApproachAdvisor.js:L232` (process.env)
  - `backend/services/medicalNecessity.js:L339` (process.env)
  - `backend/services/pipelineAutomation.js:L486` (process.env)
  - `backend/utils/aiProviders.js:L127–L201` (process.env)

### `OPENAI_TIMEOUT_MS`

- **Templates**:
  - `.env.example:631` = ``
  - `backend/.env.example:600` = ``
- **Code references**:
  - `backend/utils/openaiClient.js:L73` (process.env)

### `OPPORTUNITY_INSERT_VERIFY_URL`

- **Templates**:
  - `.env.example:632` = `http://127.0.0.1:8080`
  - `backend/.env.example:601` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/opportunityInserter.js:L638` (process.env)

### `OPPORTUNITY_MIN_COUNT`

- **Templates**:
  - `.env.example:633` = ``
  - `backend/.env.example:602` = ``
- **Code references**:
  - `backend/services/dataReadinessService.js:L27` (process.env)

### `OPPORTUNITY_STALE_DAYS`

- **Templates**:
  - `.env.example:634` = ``
  - `backend/.env.example:603` = ``
- **Code references**:
  - `backend/services/dataReadinessService.js:L21` (process.env)

### `ORPHAN_MAINTENANCE_CONFIRM`

- **Templates**:
  - `.env.example:635` = ``
  - `backend/.env.example:604` = ``
- **Code references**:
  - `backend/scripts/maintenance-orphan-profiles.mjs:L42` (process.env)

### `OWNER_ACCESS_TOKEN`

- **Templates**:
  - `.env.example:636` = `<REPLACE_ME>`
  - `backend/.env.example:605` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/verification/owner-profile-access.mjs:L35` (env helper)

### `OWNER_ALIAS_EMAIL`

- **Templates**:
  - `.env.example:637` = ``
  - `backend/.env.example:606` = ``
- **Code references**:
  - `backend/services/comms/commsService.js:L45` (process.env)

### `OWNER_CONTACT_EMAILS`

- **Templates**:
  - `.env.example:638` = ``
  - `backend/.env.example:607` = ``
- **Code references**:
  - `backend/services/yana/yanaContactsImport.js:L113` (process.env)

### `OWNER_EMAIL`

- **Templates**:
  - `.env.example:639` = ``
  - `backend/.env.example:608` = ``
- **Code references**:
  - `scripts/verification/owner-profile-access.mjs:L34` (env helper)

### `PGDATABASE`

- **Templates**:
  - `.env.example:640` = ``
  - `backend/.env.example:609` = ``
- **Code references**:
  - `backend/db/index.js:L14–L39` (process.env)

### `PGHOST`

- **Templates**:
  - `.env.example:641` = ``
  - `backend/.env.example:610` = ``
- **Code references**:
  - `backend/db/index.js:L14–L35` (process.env)

### `PGPASSWORD`

- **Templates**:
  - `.env.example:642` = `<REPLACE_ME>`
  - `backend/.env.example:611` = `<REPLACE_ME>`
- **Code references**:
  - `backend/db/index.js:L38` (process.env)

### `PGPORT`

- **Templates**:
  - `.env.example:643` = `5432`
  - `backend/.env.example:612` = `5432`
- **Code references**:
  - `backend/db/index.js:L36` (process.env)

### `PGSSLMODE`

- **Templates**:
  - `.env.example:644` = ``
  - `backend/.env.example:613` = ``
- **Code references**:
  - `backend/db/index.js:L40–L597` (process.env)

### `PGUSER`

- **Templates**:
  - `.env.example:645` = ``
  - `backend/.env.example:614` = ``
- **Code references**:
  - `backend/db/index.js:L14–L37` (process.env)

### `PG_POOL_CONN_TIMEOUT_MS`

- **Templates**:
  - `.env.example:646` = ``
  - `backend/.env.example:615` = ``
- **Code references**:
  - `backend/db/index.js:L603` (process.env)

### `PG_POOL_IDLE_MS`

- **Templates**:
  - `.env.example:647` = ``
  - `backend/.env.example:616` = ``
- **Code references**:
  - `backend/db/index.js:L602` (process.env)

### `PG_POOL_MAX`

- **Templates**:
  - `.env.example:648` = ``
  - `backend/.env.example:617` = ``
- **Code references**:
  - `backend/db/index.js:L601` (process.env)

### `PG_STATEMENT_TIMEOUT_MS`

- **Templates**:
  - `.env.example:649` = ``
  - `backend/.env.example:618` = ``
- **Code references**:
  - `backend/db/index.js:L604` (process.env)

### `PIPELINE_INSERT_RELEVANCE_FLOOR`

- **Templates**:
  - `.env.example:650` = ``
  - `backend/.env.example:619` = ``
- **Code references**:
  - `backend/config/relevanceFloor.js:L37` (process.env)

### `PIPELINE_JOB_TIMEOUT_MS`

- **Templates**:
  - `.env.example:651` = ``
  - `backend/.env.example:620` = ``
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L71` (process.env)

### `PIPELINE_PROMOTION_HOUR_ET`

- **Templates**:
  - `.env.example:652` = ``
  - `backend/.env.example:621` = ``
- **Code references**:
  - `backend/server.js:L4064` (process.env)
  - `backend/services/pipelinePromotion.js:L396` (process.env)

### `PIPELINE_PURGE_RELEVANCE_FLOOR`

- **Templates**:
  - `.env.example:653` = ``
  - `backend/.env.example:622` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L116` (process.env)

### `PIPELINE_RELEVANCE_FLOOR`

- **Templates**:
  - `.env.example:654` = ``
  - `backend/.env.example:623` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L93–L148` (process.env)

### `PIPELINE_SLOW_MS`

- **Templates**:
  - `.env.example:655` = ``
  - `backend/.env.example:624` = ``
- **Code references**:
  - `backend/middleware/pipelineMonitor.js:L15` (process.env)

### `PIPELINE_TIMEOUT_MS`

- **Templates**:
  - `.env.example:656` = ``
  - `backend/.env.example:625` = ``
- **Code references**:
  - `backend/server.js:L2322` (process.env)

### `PIPELINE_TRUSTED_RELEVANCE_FLOOR`

- **Templates**:
  - `.env.example:657` = ``
  - `backend/.env.example:626` = ``
- **Code references**:
  - `backend/config/relevanceFloor.js:L61` (process.env)

### `POINTER_TASK_RECLASS_LIMIT`

- **Templates**:
  - `.env.example:658` = ``
  - `backend/.env.example:627` = ``
- **Code references**:
  - `backend/tests/pointerTaskStartupInvariant.test.js:L16–L109` (process.env)

### `POINTER_TASK_RECLASS_SCAN_LIMIT`

- **Templates**:
  - `.env.example:659` = ``
  - `backend/.env.example:628` = ``
- **Code references**:
  - `backend/tests/pointerTaskStartupInvariant.test.js:L17–L110` (process.env)

### `PORT`

- **Templates**:
  - `.env.example:660` = `8080`
  - `backend/.env.example:629` = `8080`
- **Code references**:
  - `backend/routes/sam.js:L164` (process.env)
  - `backend/server.js:L225–L3562` (process.env)
  - `backend/services/anyaAdminTools.js:L1332` (process.env)
  - `backend/services/anyaAutonomousFunctionTesting.js:L210` (process.env)
  - `backend/services/anyaStartupAudit.js:L40` (process.env)
  - `backend/services/anyaToolRegistry.js:L4230–L4415` (process.env)
  - `backend/services/sam/samDiagnostics.js:L213` (process.env)
  - `backend/services/sam/samHttpProbe.js:L31` (process.env)
  - `backend/start.js:L42–L51` (process.env)
  - `backend/tests/testServer.js:L16` (process.env)
  - `backend/utils/internalSelfBaseUrl.js:L26` (process.env)
  - `scripts/runtime-crawl-local.mjs:L78` (process.env)
  - `tests/smoke/playwright.config.mjs:L24` (process.env)

### `PORTAL_SESSION_STAMP_LIMIT`

- **Templates**:
  - `.env.example:661` = ``
  - `backend/.env.example:630` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5360` (process.env)
  - `backend/tests/portalSyncStaleness.test.js:L531` (process.env)

### `PORTAL_SYNC_LLM_EXTRACT`

- **Templates**:
  - `.env.example:662` = ``
  - `backend/.env.example:631` = ``
- **Code references**:
  - `backend/tests/portalLlmExtract.test.js:L48–L98` (process.env)

### `PORTAL_SYNC_REQUEST_TIMEOUT_MS`

- **Templates**:
  - `.env.example:663` = ``
  - `backend/.env.example:632` = ``
- **Code references**:
  - `backend/routes/hamiltonPortalSync.js:L68` (process.env)

### `PORTAL_WALL_REPROBE_MS`

- **Templates**:
  - `.env.example:664` = ``
  - `backend/.env.example:633` = ``
- **Code references**:
  - `backend/services/hamilton/hamiltonPortalPolicyRegistry.js:L208` (process.env)

### `POSTGRES_DB`

- **Templates**:
  - `.env.example:665` = ``
  - `backend/.env.example:634` = ``
- **Code references**:
  - `backend/db/index.js:L39` (process.env)

### `POSTGRES_HOST`

- **Templates**:
  - `.env.example:666` = ``
  - `backend/.env.example:635` = ``
- **Code references**:
  - `backend/db/index.js:L35` (process.env)

### `POSTGRES_PASSWORD`

- **Templates**:
  - `.env.example:667` = `<REPLACE_ME>`
  - `backend/.env.example:636` = `<REPLACE_ME>`
- **Code references**:
  - `backend/db/index.js:L38` (process.env)

### `POSTGRES_PORT`

- **Templates**:
  - `.env.example:668` = `8080`
  - `backend/.env.example:637` = `8080`
- **Code references**:
  - `backend/db/index.js:L36` (process.env)

### `POSTGRES_USER`

- **Templates**:
  - `.env.example:669` = ``
  - `backend/.env.example:638` = ``
- **Code references**:
  - `backend/db/index.js:L37` (process.env)

### `PREVIEW_PORT`

- **Templates**:
  - `.env.example:670` = `8080`
  - `backend/.env.example:639` = `8080`
- **Code references**:
  - `scripts/runtime-crawl-local.mjs:L77` (process.env)

### `PRICING_ADMIN_NOTIFICATION_EMAIL`

- **Templates**:
  - `.env.example:671` = ``
  - `backend/.env.example:640` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L236` (env key registry)

### `PRICING_ADMIN_TOASTS_ENABLED`

- **Templates**:
  - `.env.example:672` = ``
  - `backend/.env.example:641` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L237` (env key registry)

### `PRICING_ALLOW_LIMITED_MATCH_PREVIEW_BEFORE_PAYMENT`

- **Templates**:
  - `.env.example:673` = ``
  - `backend/.env.example:642` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L236` (env key registry)

### `PRICING_AUTO_DISCOUNTS_ENABLED`

- **Templates**:
  - `.env.example:674` = ``
  - `backend/.env.example:643` = ``
- **Code references**:
  - `backend/services/pricing/chargeResolver.js:L51` (process.env)
  - `backend/services/pricing/pricingTypes.js:L228` (env key registry)
  - `tests/unit/discount-engine.test.mjs:L17` (process.env)

### `PRICING_AUTO_INITIALIZE_ON_PROFILE_CREATE`

- **Templates**:
  - `.env.example:675` = ``
  - `backend/.env.example:644` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L239` (env key registry)

### `PRICING_DISCOUNTS_ENABLED`

- **Templates**:
  - `.env.example:676` = ``
  - `backend/.env.example:645` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L227` (env key registry)
  - `tests/unit/discount-engine.test.mjs:L16–L126` (process.env)

### `PRICING_MAX_TOTAL_DISCOUNT_PERCENT`

- **Templates**:
  - `.env.example:677` = ``
  - `backend/.env.example:646` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L230` (env key registry)
  - `tests/unit/discount-engine.test.mjs:L19–L63` (process.env)

### `PRICING_REQUIRE_ADMIN_APPROVAL`

- **Templates**:
  - `.env.example:678` = ``
  - `backend/.env.example:647` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L233` (env key registry)
  - `tests/unit/admin-pricing-notifications.test.mjs:L5` (process.env)
  - `tests/unit/payment-gate-routing.test.mjs:L5` (process.env)
  - `tests/unit/profile-pricing-initializer.test.mjs:L9` (process.env)

### `PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS`

- **Templates**:
  - `.env.example:679` = ``
  - `backend/.env.example:648` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L230` (env key registry)
  - `tests/unit/discount-engine.test.mjs:L18` (process.env)

### `PRICING_REQUIRE_PAYMENT_BEFORE_FULL_ACCESS`

- **Templates**:
  - `.env.example:680` = ``
  - `backend/.env.example:649` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L235` (env key registry)

### `PRICING_SHOW_CLIENT_ESTIMATE`

- **Templates**:
  - `.env.example:681` = ``
  - `backend/.env.example:650` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L231` (env key registry)

### `PRICING_SHOW_DISCOUNT_ELIGIBILITY_TO_CLIENT`

- **Templates**:
  - `.env.example:682` = ``
  - `backend/.env.example:651` = ``
- **Code references**:
  - `backend/services/pricing/pricingTypes.js:L233` (env key registry)

### `PROBE_BASE_URL`

- **Templates**:
  - `.env.example:683` = `http://127.0.0.1:8080`
  - `backend/.env.example:652` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/probe-deferred-rcs.mjs:L23` (process.env)

### `PROD`

- **Templates**: (not present)
- **Code references**:
  - `src/config/env.js:L32` (import.meta.env)
  - `src/utils/enforceCanonicalHost.js:L4` (import.meta.env)

### `PROFILE_DISCOVERY_LINK_LIMIT`

- **Templates**:
  - `.env.example:684` = ``
  - `backend/.env.example:653` = ``
- **Code references**:
  - `backend/tests/profileDiscoveryLinkage.test.js:L351` (process.env)

### `PROFILE_DOCS_ADMIN_USER_ID`

- **Templates**:
  - `.env.example:685` = ``
  - `backend/.env.example:654` = ``
- **Code references**:
  - `backend/scripts/create-all-profiles-from-docs.mjs:L28` (env helper)

### `PROFILE_DOCS_CONFIRM`

- **Templates**:
  - `.env.example:686` = ``
  - `backend/.env.example:655` = ``
- **Code references**:
  - `backend/scripts/create-all-profiles-from-docs.mjs:L32` (env helper)
  - `tests/unit/operational-script-authority-safety.test.mjs:L135` (env helper)

### `PROFILE_DOCS_CONFIRM_DB_PATH`

- **Templates**:
  - `.env.example:687` = ``
  - `backend/.env.example:656` = ``
- **Code references**:
  - `backend/scripts/create-all-profiles-from-docs.mjs:L25` (env helper)

### `PROFILE_DOCS_DB_PATH`

- **Templates**:
  - `.env.example:688` = ``
  - `backend/.env.example:657` = ``
- **Code references**:
  - `backend/scripts/create-all-profiles-from-docs.mjs:L24` (env helper)

### `PROFILE_DOCS_SOURCE_DIR`

- **Templates**:
  - `.env.example:689` = ``
  - `backend/.env.example:658` = ``
- **Code references**:
  - `backend/scripts/create-all-profiles-from-docs.mjs:L26` (env helper)

### `PROFILE_DOCS_UPLOADS_DIR`

- **Templates**:
  - `.env.example:690` = ``
  - `backend/.env.example:659` = ``
- **Code references**:
  - `backend/scripts/create-all-profiles-from-docs.mjs:L27` (env helper)

### `PROFILE_GATE_TRUST_ENGINE`

- **Templates**:
  - `.env.example:691` = ``
  - `backend/.env.example:660` = ``
- **Code references**:
  - `backend/services/matching/profileSpecificGate.js:L50` (process.env)

### `PROFILE_ID`

- **Templates**:
  - `.env.example:692` = ``
  - `backend/.env.example:661` = ``
- **Code references**:
  - `backend/scripts/purge-ineligible-pipeline.mjs:L33` (process.env)
  - `scripts/verify-add-to-pipeline-from-opportunity.mjs:L71` (process.env)

### `PROFILE_RESULT_TARGET`

- **Templates**:
  - `.env.example:693` = ``
  - `backend/.env.example:662` = ``
- **Code references**:
  - `backend/config/profileResultFloor.js:L161–L165` (process.env)

### `PROFILE_SCOPE_CI_STRICT`

- **Templates**:
  - `.env.example:694` = ``
  - `backend/.env.example:663` = ``
- **Code references**:
  - `scripts/codemod/no-unscoped-profile-query.mjs:L106` (process.env)

### `PROFILE_SCOPE_FUNDING_READS`

- **Templates**:
  - `.env.example:695` = ``
  - `backend/.env.example:664` = ``
- **Code references**:
  - `backend/db/scopedQuery.js:L276` (process.env)
  - `tests/unit/scoped-query.test.mjs:L135–L143` (process.env)

### `PROFILE_SCOPE_MODE`

- **Templates**:
  - `.env.example:696` = ``
  - `backend/.env.example:665` = ``
- **Code references**:
  - `backend/db/scopedQuery.js:L293` (process.env)
  - `tests/unit/scoped-query.test.mjs:L55–L64` (process.env)

### `PROFILE_SCOPE_STRICT`

- **Templates**:
  - `.env.example:697` = ``
  - `backend/.env.example:666` = ``
- **Code references**:
  - `backend/db/scopedQuery.js:L294` (process.env)
  - `tests/unit/scoped-query.test.mjs:L69–L75` (process.env)

### `PROFILE_TAXONOMY_DEBUG`

- **Templates**:
  - `.env.example:698` = ``
  - `backend/.env.example:667` = ``
- **Code references**:
  - `backend/services/profile/profileTaxonomy.js:L977` (process.env)

### `PROMOTION_AMOUNT_BUDGET`

- **Templates**:
  - `.env.example:699` = ``
  - `backend/.env.example:668` = ``
- **Code references**:
  - `backend/services/pipelinePromotion.js:L268` (process.env)

### `PROMOTION_AMOUNT_GRACE_DAYS`

- **Templates**:
  - `.env.example:700` = ``
  - `backend/.env.example:669` = ``
- **Code references**:
  - `backend/services/sam/samRegistry.js:L89` (process.env)

### `PROMOTION_BATCH`

- **Templates**:
  - `.env.example:701` = ``
  - `backend/.env.example:670` = ``
- **Code references**:
  - `backend/services/pipelinePromotion.js:L266` (process.env)

### `PROMOTION_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:702` = ``
  - `backend/.env.example:671` = ``
- **Code references**:
  - `backend/services/pipelinePromotion.js:L267` (process.env)

### `PROPOSAL_CRITIC`

- **Templates**:
  - `.env.example:703` = ``
  - `backend/.env.example:672` = ``
- **Code references**:
  - `backend/services/proposalCritic.js:L40` (process.env)
  - `backend/tests/proposalCritic.test.js:L16–L136` (process.env)

### `PUBLIC_APP_URL`

- **Templates**:
  - `.env.example:704` = `http://127.0.0.1:8080`
  - `backend/.env.example:673` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/stripeService.js:L100` (process.env)

### `PUBLIC_URL`

- **Templates**:
  - `.env.example:705` = `http://127.0.0.1:8080`
  - `backend/.env.example:674` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/routes/auth.js:L201` (process.env)
  - `backend/routes/stripe.js:L24` (process.env)
  - `backend/services/diagnosticsService.js:L415` (process.env)

### `QUEUE_DRAIN_INTERVAL_MS`

- **Templates**:
  - `.env.example:706` = ``
  - `backend/.env.example:675` = ``
- **Code references**:
  - `backend/services/crawlerDispatcher.js:L801` (process.env)

### `QUEUE_POLL_ENABLED`

- **Templates**:
  - `.env.example:707` = ``
  - `backend/.env.example:676` = ``
- **Code references**:
  - `backend/server.js:L3436` (process.env)
  - `backend/startup/queueRecovery.js:L157` (process.env)

### `QUEUE_POLL_INTERVAL_MS`

- **Templates**:
  - `.env.example:708` = ``
  - `backend/.env.example:677` = ``
- **Code references**:
  - `backend/server.js:L3435` (process.env)
  - `backend/startup/queueRecovery.js:L153` (process.env)

### `QUEUE_STAGGER_DELAY_MS`

- **Templates**:
  - `.env.example:709` = ``
  - `backend/.env.example:678` = ``
- **Code references**:
  - `backend/server.js:L3441` (process.env)
  - `backend/startup/queueRecovery.js:L252` (process.env)

### `QUEUE_STARTUP_DELAY_MS`

- **Templates**:
  - `.env.example:710` = ``
  - `backend/.env.example:679` = ``
- **Code references**:
  - `backend/server.js:L3440` (process.env)
  - `backend/startup/queueRecovery.js:L248` (process.env)

### `RAILWAY_DEPLOYMENT_ID`

- **Templates**:
  - `.env.example:711` = ``
  - `backend/.env.example:680` = ``
- **Code references**:
  - `backend/config/constants.js:L13` (process.env)
  - `backend/db/index.js:L105` (process.env)
  - `backend/routes/anya.js:L136` (process.env)
  - `backend/server.js:L203` (process.env)
  - `backend/services/agentControl/agentControlOrchestrator.js:L172` (process.env)

### `RAILWAY_DEPLOYMENT_START_TIME`

- **Templates**:
  - `.env.example:712` = ``
  - `backend/.env.example:681` = ``
- **Code references**:
  - `backend/server.js:L2798` (process.env)

### `RAILWAY_ENVIRONMENT`

- **Templates**:
  - `.env.example:713` = ``
  - `backend/.env.example:682` = ``
- **Code references**:
  - `backend/db/index.js:L65–L102` (process.env)
  - `backend/routes/auth.js:L485–L3363` (process.env)
  - `backend/routes/health.js:L81` (process.env)
  - `backend/routes/version.js:L37–L38` (process.env)
  - `backend/services/email.js:L23` (process.env)
  - `backend/services/productionAuditSnapshot.js:L443` (process.env)
  - `backend/tests/otpLoginRetired.test.js:L52–L77` (process.env)
  - `backend/utils/environment.js:L13–L23` (process.env)

### `RAILWAY_ENVIRONMENT_ID`

- **Templates**:
  - `.env.example:714` = ``
  - `backend/.env.example:683` = ``
- **Code references**:
  - `backend/config/constants.js:L12` (process.env)
  - `backend/server.js:L202` (process.env)
  - `backend/services/agentControl/agentControlOrchestrator.js:L171` (process.env)

### `RAILWAY_GIT_BRANCH`

- **Templates**:
  - `.env.example:715` = ``
  - `backend/.env.example:684` = ``
- **Code references**:
  - `backend/routes/health.js:L536` (process.env)
  - `backend/routes/version.js:L35` (process.env)

### `RAILWAY_GIT_COMMIT_SHA`

- **Templates**:
  - `.env.example:716` = ``
  - `backend/.env.example:685` = ``
- **Code references**:
  - `backend/db/index.js:L104` (process.env)
  - `backend/routes/health.js:L71–L535` (process.env)
  - `backend/routes/version.js:L33` (process.env)
  - `backend/server.js:L23–L2447` (process.env)
  - `backend/services/productionAuditSnapshot.js:L440` (process.env)
  - `backend/startup/backgroundServices.js:L416` (process.env)
  - `backend/utils/observability.js:L31` (process.env)

### `RAILWAY_PROJECT_ID`

- **Templates**:
  - `.env.example:717` = ``
  - `backend/.env.example:686` = ``
- **Code references**:
  - `backend/db/index.js:L12–L100` (process.env)

### `RAILWAY_SERVICE_ID`

- **Templates**:
  - `.env.example:718` = ``
  - `backend/.env.example:687` = ``
- **Code references**:
  - `backend/db/index.js:L12–L101` (process.env)

### `RAILWAY_STATIC_URL`

- **Templates**:
  - `.env.example:719` = `http://127.0.0.1:8080`
  - `backend/.env.example:688` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/db/index.js:L103` (process.env)

### `RAILWAY_VOLUME_MOUNT_PATH`

- **Templates**:
  - `.env.example:720` = ``
  - `backend/.env.example:689` = ``
- **Code references**:
  - `backend/services/maintenance/diskUsage.js:L28` (process.env)

### `REATTACH_ADMIN_USER_ID`

- **Templates**:
  - `.env.example:721` = ``
  - `backend/.env.example:690` = ``
- **Code references**:
  - `scripts/reattach-users-simple.mjs:L55` (env helper)

### `REATTACH_CONFIRM`

- **Templates**:
  - `.env.example:722` = ``
  - `backend/.env.example:691` = ``
- **Code references**:
  - `scripts/reattach-users-simple.mjs:L63` (env helper)
  - `tests/unit/operational-script-authority-safety.test.mjs:L131` (env helper)

### `REATTACH_CONFIRM_DB_PATH`

- **Templates**:
  - `.env.example:723` = ``
  - `backend/.env.example:692` = ``
- **Code references**:
  - `scripts/reattach-users-simple.mjs:L54` (env helper)

### `REATTACH_DB_PATH`

- **Templates**:
  - `.env.example:724` = ``
  - `backend/.env.example:693` = ``
- **Code references**:
  - `scripts/reattach-users-simple.mjs:L53` (env helper)

### `REATTACH_SUMMARY_PATH`

- **Templates**:
  - `.env.example:725` = ``
  - `backend/.env.example:694` = ``
- **Code references**:
  - `scripts/reattach-users-simple.mjs:L56` (env helper)

### `REGISTRY_VERIFICATION_TIMEOUT_MS`

- **Templates**:
  - `.env.example:726` = ``
  - `backend/.env.example:695` = ``
- **Code references**:
  - `backend/services/verification/verificationConfig.js:L51` (env helper)

### `REPO_REWARDS_URL`

- **Templates**:
  - `.env.example:727` = `http://127.0.0.1:8080`
  - `backend/.env.example:696` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/amy/repoRewardsScout.js:L62` (process.env)
  - `backend/tests/repoRewardsScout.test.js:L134–L142` (process.env)

### `REQUEST_ID_ERROR_STORE_MAX`

- **Templates**:
  - `.env.example:728` = ``
  - `backend/.env.example:697` = ``
- **Code references**:
  - `backend/services/requestIdErrorStore.js:L1` (process.env)

### `REQUEST_TIMEOUT_MS`

- **Templates**:
  - `.env.example:729` = ``
  - `backend/.env.example:698` = ``
- **Code references**:
  - `backend/server.js:L495` (process.env)

### `RESEND_API_KEY`

- **Templates**:
  - `.env.example:730` = `<REPLACE_ME>`
  - `backend/.env.example:699` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/auth.js:L3256–L3360` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L22` (process.env)
  - `backend/services/diagnosticsService.js:L408` (process.env)
  - `backend/services/email.js:L20–L27` (process.env)
  - `backend/tests/emailSendHonesty.test.js:L26` (process.env)

### `RESULT_FLOOR_PROFILE_LIMIT`

- **Templates**:
  - `.env.example:731` = ``
  - `backend/.env.example:700` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L8125–L8128` (process.env)

### `ROBERT_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:732` = `<REPLACE_ME>`
  - `backend/.env.example:701` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/robert.js:L63` (process.env)

### `ROBERT_ALLOW_LIVE_WEB`

- **Templates**:
  - `.env.example:733` = ``
  - `backend/.env.example:702` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L79` (env helper)
  - `tests/unit/robert-agent-silent-failure.test.mjs:L24–L39` (process.env)
  - `tests/unit/robert-agent.test.mjs:L12–L113` (process.env)

### `ROBERT_ALLOW_REVIEW_MATCH_TOASTS`

- **Templates**:
  - `.env.example:734` = ``
  - `backend/.env.example:703` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L101` (env helper)

### `ROBERT_ALLOW_SEARCH_ENGINE`

- **Templates**:
  - `.env.example:735` = ``
  - `backend/.env.example:704` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L80` (env helper)

### `ROBERT_ALLOW_SOURCE_DISCOVERY`

- **Templates**:
  - `.env.example:736` = ``
  - `backend/.env.example:705` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L81` (env helper)
  - `tests/unit/robert-agent-silent-failure.test.mjs:L25` (process.env)
  - `tests/unit/robert-agent.test.mjs:L13–L90` (process.env)

### `ROBERT_AUTOSEED_MAX_ENTITIES`

- **Templates**:
  - `.env.example:737` = ``
  - `backend/.env.example:706` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L71` (env helper)

### `ROBERT_AUTOSEED_MAX_PROFILES`

- **Templates**:
  - `.env.example:738` = ``
  - `backend/.env.example:707` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L70` (env helper)

### `ROBERT_AUTOSEED_MIN_RISK`

- **Templates**:
  - `.env.example:739` = ``
  - `backend/.env.example:708` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L72` (env helper)

### `ROBERT_AUTOSEED_ON_SCHEDULE`

- **Templates**:
  - `.env.example:740` = ``
  - `backend/.env.example:709` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L68` (env helper)

### `ROBERT_AUTOSEED_SCHEDULE`

- **Templates**:
  - `.env.example:741` = ``
  - `backend/.env.example:710` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L69` (env helper)

### `ROBERT_AUTO_INGEST_VERIFIED`

- **Templates**:
  - `.env.example:742` = ``
  - `backend/.env.example:711` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L83` (env helper)
  - `tests/unit/robert-agent-silent-failure.test.mjs:L26–L40` (process.env)
  - `tests/unit/robert-agent.test.mjs:L14–L114` (process.env)

### `ROBERT_BATCH_LOW_PRIORITY_RECOMMENDATIONS`

- **Templates**:
  - `.env.example:743` = ``
  - `backend/.env.example:712` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L102` (env helper)

### `ROBERT_CONTACTS_MAILBOX`

- **Templates**:
  - `.env.example:744` = ``
  - `backend/.env.example:713` = ``
- **Code references**:
  - `backend/services/robert/robertContactDiscovery.js:L81` (process.env)

### `ROBERT_CONTACT_HARVEST`

- **Templates**:
  - `.env.example:745` = ``
  - `backend/.env.example:714` = ``
- **Code references**:
  - `backend/services/robert/robertContactHarvest.js:L33` (process.env)
  - `backend/tests/robertContactHarvest.test.js:L102–L306` (process.env)

### `ROBERT_ENABLED`

- **Templates**:
  - `.env.example:746` = ``
  - `backend/.env.example:715` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L58` (env helper)
  - `backend/tests/samDiscoveryAwareness.test.js:L240` (process.env)
  - `tests/unit/robert-agent-silent-failure.test.mjs:L23–L38` (process.env)
  - `tests/unit/robert-agent.test.mjs:L11–L112` (process.env)
  - `tests/unit/robert-safety.test.mjs:L22` (process.env)

### `ROBERT_FAIL_OPEN`

- **Templates**:
  - `.env.example:747` = ``
  - `backend/.env.example:716` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L89` (env helper)

### `ROBERT_GMAIL_ACCOUNT`

- **Templates**:
  - `.env.example:748` = ``
  - `backend/.env.example:717` = ``
- **Code references**:
  - `backend/services/robert/robertContactHarvest.js:L37` (process.env)
  - `backend/services/robert/robertMailboxReaders.js:L35` (process.env)

### `ROBERT_GMAIL_APP_PASSWORD`

- **Templates**:
  - `.env.example:749` = `<REPLACE_ME>`
  - `backend/.env.example:718` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/robert/robertMailboxReaders.js:L36` (process.env)

### `ROBERT_GRAPH_ACCOUNT`

- **Templates**:
  - `.env.example:750` = ``
  - `backend/.env.example:719` = ``
- **Code references**:
  - `backend/services/robert/robertContactHarvest.js:L40` (process.env)
  - `backend/services/robert/robertMailboxReaders.js:L41` (process.env)

### `ROBERT_HARVEST_DAYS`

- **Templates**:
  - `.env.example:751` = ``
  - `backend/.env.example:720` = ``
- **Code references**:
  - `backend/services/robert/robertContactHarvest.js:L34` (process.env)

### `ROBERT_HARVEST_MAX_CONTACTS`

- **Templates**:
  - `.env.example:752` = ``
  - `backend/.env.example:721` = ``
- **Code references**:
  - `backend/services/robert/robertContactHarvest.js:L36` (process.env)

### `ROBERT_HARVEST_MAX_MESSAGES`

- **Templates**:
  - `.env.example:753` = ``
  - `backend/.env.example:722` = ``
- **Code references**:
  - `backend/services/robert/robertContactHarvest.js:L35` (process.env)

### `ROBERT_JOHN_DEFAULT_LEAD_SCORE`

- **Templates**:
  - `.env.example:754` = ``
  - `backend/.env.example:723` = ``
- **Code references**:
  - `backend/services/robert/robertJohnBridge.js:L63` (process.env)

### `ROBERT_JOHN_MAX_LEADS_PER_24H`

- **Templates**:
  - `.env.example:755` = ``
  - `backend/.env.example:724` = ``
- **Code references**:
  - `backend/services/robert/robertJohnBridge.js:L58` (process.env)
  - `tests/unit/robert-john-bridge.test.mjs:L209–L227` (process.env)

### `ROBERT_MAX_OPPORTUNITIES_PER_RUN`

- **Templates**:
  - `.env.example:756` = ``
  - `backend/.env.example:725` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L76` (env helper)

### `ROBERT_MAX_PROFILES_PER_RUN`

- **Templates**:
  - `.env.example:757` = ``
  - `backend/.env.example:726` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L77` (env helper)

### `ROBERT_MAX_SOURCES_PER_RUN`

- **Templates**:
  - `.env.example:758` = ``
  - `backend/.env.example:727` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L74` (env helper)

### `ROBERT_MAX_TOASTS_PER_PROFILE_PER_DAY`

- **Templates**:
  - `.env.example:759` = ``
  - `backend/.env.example:728` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L92` (env helper)

### `ROBERT_MAX_URLS_PER_SOURCE`

- **Templates**:
  - `.env.example:760` = ``
  - `backend/.env.example:729` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L75` (env helper)

### `ROBERT_MESSAGE_SCAN_MAX`

- **Templates**:
  - `.env.example:761` = ``
  - `backend/.env.example:730` = ``
- **Code references**:
  - `backend/services/robert/robertContactDiscovery.js:L64` (process.env)

### `ROBERT_MIN_SOURCE_TRUST`

- **Templates**:
  - `.env.example:762` = ``
  - `backend/.env.example:731` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L84` (env helper)

### `ROBERT_MIN_TOAST_MATCH_SCORE`

- **Templates**:
  - `.env.example:763` = ``
  - `backend/.env.example:732` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L51` (env helper)
  - `tests/unit/robert-safety.test.mjs:L41–L57` (process.env)

### `ROBERT_MODE`

- **Templates**:
  - `.env.example:764` = ``
  - `backend/.env.example:733` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L73` (env helper)
  - `tests/unit/robert-agent-silent-failure.test.mjs:L27` (process.env)
  - `tests/unit/robert-agent.test.mjs:L15` (process.env)
  - `tests/unit/robert-safety.test.mjs:L35` (process.env)

### `ROBERT_PERSIST_CANDIDATES`

- **Templates**:
  - `.env.example:765` = ``
  - `backend/.env.example:734` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L82` (env helper)

### `ROBERT_RATE_LIMIT_PER_DOMAIN_PER_HOUR`

- **Templates**:
  - `.env.example:766` = ``
  - `backend/.env.example:735` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L88` (env helper)

### `ROBERT_RECOMMENDATION_LIVE_STREAM_ENABLED`

- **Templates**:
  - `.env.example:767` = ``
  - `backend/.env.example:736` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L104` (env helper)

### `ROBERT_RECOMMENDATION_POLL_INTERVAL_MS`

- **Templates**:
  - `.env.example:768` = ``
  - `backend/.env.example:737` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L103` (env helper)

### `ROBERT_RECOMMENDATION_QUEUE_ON_LOGIN`

- **Templates**:
  - `.env.example:769` = ``
  - `backend/.env.example:738` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L105` (env helper)

### `ROBERT_RECOMMENDATION_TOASTS_ENABLED`

- **Templates**:
  - `.env.example:770` = ``
  - `backend/.env.example:739` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L91` (env helper)

### `ROBERT_REQUIRE_REAL_APPLICATION_URL`

- **Templates**:
  - `.env.example:771` = `http://127.0.0.1:8080`
  - `backend/.env.example:740` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/robert/robertSafety.js:L85` (env helper)

### `ROBERT_RESPECT_ROBOTS`

- **Templates**:
  - `.env.example:772` = ``
  - `backend/.env.example:741` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L86` (env helper)

### `ROBERT_RUN_ON_SCHEDULE`

- **Templates**:
  - `.env.example:773` = ``
  - `backend/.env.example:742` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L60` (env helper)

### `ROBERT_RUN_ON_STARTUP`

- **Templates**:
  - `.env.example:774` = ``
  - `backend/.env.example:743` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L59` (env helper)

### `ROBERT_SCAN_EMAIL_CONTACTS`

- **Templates**:
  - `.env.example:775` = ``
  - `backend/.env.example:744` = ``
- **Code references**:
  - `backend/services/robert/robertContactDiscovery.js:L56` (process.env)

### `ROBERT_SCAN_EMAIL_MESSAGES`

- **Templates**:
  - `.env.example:776` = ``
  - `backend/.env.example:745` = ``
- **Code references**:
  - `backend/services/robert/robertContactDiscovery.js:L60` (process.env)

### `ROBERT_SCHEDULE`

- **Templates**:
  - `.env.example:777` = ``
  - `backend/.env.example:746` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L61` (env helper)

### `ROBERT_SCHEDULED_MODE`

- **Templates**:
  - `.env.example:778` = ``
  - `backend/.env.example:747` = ``
- **Code references**:
  - `backend/services/robert/robertScheduler.js:L103` (process.env)

### `ROBERT_TIMEOUT_MS`

- **Templates**:
  - `.env.example:779` = ``
  - `backend/.env.example:748` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L78` (env helper)

### `ROBERT_USER_AGENT`

- **Templates**:
  - `.env.example:780` = ``
  - `backend/.env.example:749` = ``
- **Code references**:
  - `backend/services/robert/robertSafety.js:L87` (env helper)

### `ROBERT_YAHOO_PRIMARY_ACCOUNT`

- **Templates**:
  - `.env.example:781` = ``
  - `backend/.env.example:750` = ``
- **Code references**:
  - `backend/services/robert/robertContactHarvest.js:L38` (process.env)
  - `backend/services/robert/robertMailboxReaders.js:L37` (process.env)

### `ROBERT_YAHOO_PRIMARY_APP_PASSWORD`

- **Templates**:
  - `.env.example:782` = `<REPLACE_ME>`
  - `backend/.env.example:751` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/robert/robertMailboxReaders.js:L38` (process.env)

### `ROBERT_YAHOO_SECONDARY_ACCOUNT`

- **Templates**:
  - `.env.example:783` = ``
  - `backend/.env.example:752` = ``
- **Code references**:
  - `backend/services/robert/robertContactHarvest.js:L39` (process.env)
  - `backend/services/robert/robertMailboxReaders.js:L39` (process.env)

### `ROBERT_YAHOO_SECONDARY_APP_PASSWORD`

- **Templates**:
  - `.env.example:784` = `<REPLACE_ME>`
  - `backend/.env.example:753` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/robert/robertMailboxReaders.js:L40` (process.env)

### `RUNTIME_SECRETS_KEY`

- **Templates**:
  - `.env.example:785` = `<REPLACE_ME>`
  - `backend/.env.example:754` = `<REPLACE_ME>`
- **Code references**:
  - `backend/tests/aidTypePreferences.test.js:L16–L16` (process.env)
  - `backend/tests/generalApplicationCoverage.test.js:L15` (process.env)
  - `backend/tests/hamiltonAutoSubmitAuthorizedLeg.test.js:L30–L30` (process.env)
  - `backend/tests/hamiltonBotProtectedBlock.test.js:L14–L14` (process.env)
  - `backend/tests/hamiltonBotProtectedDetection.test.js:L20–L20` (process.env)
  - `backend/tests/hamiltonCaptchaGeneralization.test.js:L15–L15` (process.env)
  - `backend/tests/hamiltonCloudLoginPopupFollow.test.js:L21` (process.env)
  - `backend/tests/hamiltonCloudLoginSessionSeed.test.js:L28` (process.env)
  - `backend/tests/hamiltonConfirmationProof.test.js:L30–L30` (process.env)
  - `backend/tests/hamiltonCredentialFallback.test.js:L16` (process.env)
  - `backend/tests/hamiltonDraftPacketBridge.test.js:L27–L27` (process.env)
  - `backend/tests/hamiltonFafsaLink.test.js:L27–L27` (process.env)
  - `backend/tests/hamiltonManualSubmissionReceipt.test.js:L5–L5` (process.env)
  - `backend/tests/hamiltonPortalAutopilotIdentity.test.js:L19` (process.env)
  - `backend/tests/hamiltonPortalSignupAdapter.test.js:L17` (process.env)
  - `backend/tests/hamiltonProfileSummary.test.js:L19–L19` (process.env)
  - `backend/tests/hamiltonSessionDomainMatch.test.js:L14–L14` (process.env)
  - `backend/tests/hamiltonSessionKeepAlive.test.js:L30` (process.env)
  - `backend/tests/hamiltonSessionKeepAliveHonesty.test.js:L36` (process.env)
  - `backend/tests/hamiltonSessionPersistence.test.js:L9` (process.env)
  - `backend/tests/hamiltonSignupRecovery.test.js:L14–L14` (process.env)
  - `backend/tests/hamiltonTaskCreationGate.test.js:L25–L25` (process.env)
  - `backend/tests/hamiltonTaskLifecycle.test.js:L24–L24` (process.env)
  - `backend/tests/hamiltonTodoCategory.test.js:L17–L17` (process.env)
  - `backend/tests/hamiltonVaultAutonomousUnlock.test.js:L13–L13` (process.env)
  - `backend/tests/johnBounceReconcile.test.js:L15–L15` (process.env)
  - `backend/tests/outsideAwardPacket.test.js:L19–L19` (process.env)
  - `backend/tests/pipelineEligibilitySweep.test.js:L14–L14` (process.env)
  - `backend/tests/portalAutopilotCobrowseAndMerge.test.js:L19` (process.env)
  - `backend/tests/portalAutopilotPassphraseReset.test.js:L18–L18` (process.env)
  - `backend/tests/portalCompletionAndReminder.test.js:L15` (process.env)
  - `backend/tests/portalSyncAutoMerge.test.js:L19–L19` (process.env)
  - `backend/tests/portalSyncFafsaPersist.test.js:L25–L25` (process.env)
  - `backend/tests/portalSyncRequiresSession.test.js:L12` (process.env)
  - `backend/tests/portalSyncSessionWall.test.js:L20–L20` (process.env)
  - `backend/tests/portalSyncStaleness.test.js:L20` (process.env)
  - `backend/tests/portalSyncTwoWayGlobal.test.js:L24–L24` (process.env)
  - `backend/tests/profilePortalIndex.test.js:L13` (process.env)
  - `backend/tests/profilePortalsUnlockRoute.test.js:L24–L24` (process.env)
  - `backend/tests/robertContactDiscovery.test.js:L17–L17` (process.env)
  - `backend/tests/robertContactHarvest.test.js:L23–L23` (process.env)
  - `backend/tests/thresholdAnalyzer.test.js:L15–L15` (process.env)
  - `tests/unit/hamilton-auth-backup-plan.test.mjs:L27` (process.env)
  - `tests/unit/hamilton-credential-csv-import.test.mjs:L38` (process.env)
  - `tests/unit/hamilton-credential-vault-management.test.mjs:L32` (process.env)
  - `tests/unit/hamilton-document-resume.test.mjs:L20` (process.env)
  - `tests/unit/hamilton-missing-info-alert.test.mjs:L18` (process.env)
  - `tests/unit/hamilton-missing-info-resume.test.mjs:L22` (process.env)
  - `tests/unit/hamilton-parse-reconcile.test.mjs:L20` (process.env)
  - `tests/unit/hamilton-portal-credential-vault.test.mjs:L40` (process.env)

### `RUN_GEO_CRAWL`

- **Templates**:
  - `.env.example:786` = ``
  - `backend/.env.example:755` = ``
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L155` (process.env)

### `RUN_ITEM_CRAWLERS`

- **Templates**:
  - `.env.example:787` = ``
  - `backend/.env.example:756` = ``
- **Code references**:
  - `backend/scripts/run-full-system-test.mjs:L154` (process.env)

### `RUN_SQLITE_MIGRATION`

- **Templates**:
  - `.env.example:788` = ``
  - `backend/.env.example:757` = ``
- **Code references**:
  - `backend/start.js:L103` (process.env)

### `SAM_ADVERSARIAL_MAX_REPAIRS`

- **Templates**:
  - `.env.example:789` = ``
  - `backend/.env.example:758` = ``
- **Code references**:
  - `backend/services/sam/samAdversarialRepair.js:L65` (process.env)

### `SAM_ALLOW_SAFE_REPAIR`

- **Templates**:
  - `.env.example:790` = ``
  - `backend/.env.example:759` = ``
- **Code references**:
  - `backend/routes/sam.js:L209–L271` (env helper)
  - `backend/services/sam/samAgent.js:L592` (env helper)

### `SAM_AUTO_FIX_SAFE`

- **Templates**:
  - `.env.example:791` = ``
  - `backend/.env.example:760` = ``
- **Code references**:
  - `backend/tests/samPolicy.test.js:L93–L104` (process.env)

### `SAM_CHECK_TIMEOUT_MS`

- **Templates**:
  - `.env.example:792` = ``
  - `backend/.env.example:761` = ``
- **Code references**:
  - `backend/services/sam/samDiagnostics.js:L53` (process.env)

### `SAM_DAILY_CODE_SWEEP_ENABLED`

- **Templates**:
  - `.env.example:793` = ``
  - `backend/.env.example:762` = ``
- **Code references**:
  - `backend/services/sam/samDailyCodeSweep.js:L27` (process.env)
  - `backend/tests/samDailyCodeSweep.test.js:L16–L63` (process.env)

### `SAM_DAILY_CODE_SWEEP_HOUR_ET`

- **Templates**:
  - `.env.example:794` = ``
  - `backend/.env.example:763` = ``
- **Code references**:
  - `backend/server.js:L4094` (process.env)

### `SAM_EMAIL_REPORTS`

- **Templates**:
  - `.env.example:795` = ``
  - `backend/.env.example:764` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L601` (process.env)

### `SAM_ENABLED`

- **Templates**:
  - `.env.example:796` = ``
  - `backend/.env.example:765` = ``
- **Code references**:
  - `backend/routes/sam.js:L66` (env helper)
  - `backend/services/sam/samAgent.js:L591` (env helper)
  - `backend/services/sam/samScheduler.js:L43` (process.env)

### `SAM_FAIL_ON_CRITICAL`

- **Templates**:
  - `.env.example:797` = ``
  - `backend/.env.example:766` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L227–L599` (env helper)

### `SAM_GOV_API_BASE_URL`

- **Templates**:
  - `.env.example:798` = `http://127.0.0.1:8080`
  - `backend/.env.example:767` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/connectors/samGovConnector.js:L22` (process.env)

### `SAM_GOV_API_KEY`

- **Templates**:
  - `.env.example:799` = `<REPLACE_ME>`
  - `backend/.env.example:768` = `<REPLACE_ME>`
- **Code references**:
  - `backend/config/grantsGovEndpoints.js:L48` (process.env)
  - `backend/services/diagnosticsService.js:L402` (process.env)
  - `backend/src/config/apiKeys.js:L41` (env helper)
  - `backend/tests/samDiscoveryAwareness.test.js:L228` (process.env)
  - `backend/tests/samGovApiKey.test.js:L11–L61` (process.env)

### `SAM_GOV_KEY`

- **Templates**:
  - `.env.example:800` = `<REPLACE_ME>`
  - `backend/.env.example:769` = `<REPLACE_ME>`
- **Code references**:
  - `backend/config/grantsGovEndpoints.js:L50` (process.env)
  - `backend/src/config/apiKeys.js:L43` (env helper)

### `SAM_GOV_PUBLIC_API_KEY`

- **Templates**:
  - `.env.example:801` = `<REPLACE_ME>`
  - `backend/.env.example:770` = `<REPLACE_ME>`
- **Code references**:
  - `backend/config/grantsGovEndpoints.js:L47` (process.env)
  - `backend/services/connectorIngestService.js:L436` (process.env)
  - `backend/services/diagnosticsService.js:L402` (process.env)
  - `backend/src/config/apiKeys.js:L40` (env helper)
  - `backend/src/integrations/samAssistanceListings.js:L29–L74` (process.env)
  - `backend/tests/samDiscoveryAwareness.test.js:L215–L227` (process.env)
  - `backend/tests/samGovApiKey.test.js:L11–L60` (process.env)

### `SAM_HTTP_PROBE_TIMEOUT_MS`

- **Templates**:
  - `.env.example:802` = ``
  - `backend/.env.example:771` = ``
- **Code references**:
  - `backend/services/sam/samHttpProbe.js:L23` (process.env)

### `SAM_MAX_FIXES_PER_RUN`

- **Templates**:
  - `.env.example:803` = ``
  - `backend/.env.example:772` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L742` (process.env)

### `SAM_MODE`

- **Templates**:
  - `.env.example:804` = ``
  - `backend/.env.example:773` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L596` (process.env)
  - `backend/services/sam/samScheduler.js:L64` (process.env)

### `SAM_REPORT_EMAIL`

- **Templates**:
  - `.env.example:805` = ``
  - `backend/.env.example:774` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L603` (process.env)

### `SAM_RUN_ON_SCHEDULE`

- **Templates**:
  - `.env.example:806` = ``
  - `backend/.env.example:775` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L593` (env helper)
  - `backend/services/sam/samScheduler.js:L51` (process.env)

### `SAM_RUN_ON_STARTUP`

- **Templates**:
  - `.env.example:807` = ``
  - `backend/.env.example:776` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L594` (env helper)
  - `backend/services/sam/samScheduler.js:L47` (process.env)

### `SAM_SCHEDULE`

- **Templates**:
  - `.env.example:808` = ``
  - `backend/.env.example:777` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L597` (process.env)
  - `backend/services/sam/samScheduler.js:L150–L169` (process.env)

### `SAM_SCHEDULE_AUTOFIX`

- **Templates**:
  - `.env.example:809` = ``
  - `backend/.env.example:778` = ``
- **Code references**:
  - `backend/services/sam/samAgent.js:L595` (env helper)
  - `backend/services/sam/samScheduler.js:L55` (process.env)

### `SCHOOL_PORTAL_VERIFY_BASE`

- **Templates**:
  - `.env.example:810` = ``
  - `backend/.env.example:779` = ``
- **Code references**:
  - `scripts/verify-school-portal-live.mjs:L25` (process.env)

### `SCORE_BACKFILL_BATCH`

- **Templates**:
  - `.env.example:811` = ``
  - `backend/.env.example:780` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L5222` (process.env)

### `SEARXNG_ENGINES`

- **Templates**:
  - `.env.example:812` = ``
  - `backend/.env.example:781` = ``
- **Code references**:
  - `backend/services/shared/searxngProvider.js:L93` (process.env)

### `SEARXNG_FALLBACK_ENGINES`

- **Templates**:
  - `.env.example:813` = ``
  - `backend/.env.example:782` = ``
- **Code references**:
  - `backend/services/searchProviderHealth.js:L148` (process.env)
  - `backend/services/shared/webSearchEngine.js:L496` (process.env)
  - `backend/tests/searchProviderHealth.test.js:L46` (process.env)
  - `backend/tests/webSearchEngine.test.js:L349–L358` (process.env)

### `SEARXNG_MIN_INTERVAL_MS`

- **Templates**:
  - `.env.example:814` = ``
  - `backend/.env.example:783` = ``
- **Code references**:
  - `backend/services/shared/searxngProvider.js:L49` (process.env)

### `SEARXNG_URL`

- **Templates**:
  - `.env.example:815` = `http://127.0.0.1:8080`
  - `backend/.env.example:784` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/searchProviderHealth.js:L108` (process.env)
  - `backend/services/shared/searxngProvider.js:L81–L90` (process.env)
  - `backend/services/shared/webSearchEngine.js:L94` (process.env)
  - `backend/tests/searchProviderHealth.test.js:L39–L126` (process.env)
  - `backend/tests/webSearchEngine.test.js:L74–L725` (process.env)

### `SEED_KEY`

- **Templates**:
  - `.env.example:816` = `<REPLACE_ME>`
  - `backend/.env.example:785` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/admin.js:L3572` (process.env)

### `SEED_PATH`

- **Templates**:
  - `.env.example:817` = ``
  - `backend/.env.example:786` = ``
- **Code references**:
  - `scripts/seed-profiles.mjs:L51–L52` (process.env)

### `SEMANTIC_RECALL`

- **Templates**:
  - `.env.example:818` = ``
  - `backend/.env.example:787` = ``
- **Code references**:
  - `backend/services/embeddings/embeddingService.js:L41` (process.env)

### `SEMANTIC_RECALL_SCAN_LIMIT`

- **Templates**:
  - `.env.example:819` = ``
  - `backend/.env.example:788` = ``
- **Code references**:
  - `backend/services/embeddings/embeddingService.js:L55` (process.env)

### `SEMANTIC_RECALL_TOP_K`

- **Templates**:
  - `.env.example:820` = ``
  - `backend/.env.example:789` = ``
- **Code references**:
  - `backend/services/embeddings/embeddingService.js:L47` (process.env)

### `SENDGRID_API_KEY`

- **Templates**:
  - `.env.example:821` = `<REPLACE_ME>`
  - `backend/.env.example:790` = `<REPLACE_ME>`
- **Code references**:
  - `backend/tests/onboardingRoute.test.js:L187` (process.env)

### `SENTRY_DSN`

- **Templates**:
  - `.env.example:822` = ``
  - `backend/.env.example:791` = ``
- **Code references**:
  - `backend/utils/observability.js:L20` (process.env)

### `SENTRY_ENVIRONMENT`

- **Templates**:
  - `.env.example:823` = ``
  - `backend/.env.example:792` = ``
- **Code references**:
  - `backend/utils/observability.js:L28` (process.env)

### `SENTRY_RELEASE`

- **Templates**:
  - `.env.example:824` = ``
  - `backend/.env.example:793` = ``
- **Code references**:
  - `backend/utils/observability.js:L30` (process.env)

### `SENTRY_TRACES_SAMPLE_RATE`

- **Templates**:
  - `.env.example:825` = ``
  - `backend/.env.example:794` = ``
- **Code references**:
  - `backend/utils/observability.js:L34` (process.env)

### `SERVICE_APPLICATION_EMAIL`

- **Templates**:
  - `.env.example:826` = ``
  - `backend/.env.example:795` = ``
- **Code references**:
  - `backend/routes/serviceApplication.js:L15` (process.env)

### `SERVICE_CATALOG_SEED_TTL_MS`

- **Templates**:
  - `.env.example:827` = ``
  - `backend/.env.example:796` = ``
- **Code references**:
  - `backend/services/serviceCatalogStore.js:L28` (process.env)

### `SHOULDERS_VNEXT`

- **Templates**:
  - `.env.example:828` = ``
  - `backend/.env.example:797` = ``
- **Code references**:
  - `backend/routes/vnextApplications.js:L24` (process.env)
  - `backend/tests/vnext-shoulders.test.js:L12` (process.env)

### `SHUTDOWN_GRACE_MS`

- **Templates**:
  - `.env.example:829` = ``
  - `backend/.env.example:798` = ``
- **Code references**:
  - `backend/server.js:L3006` (process.env)

### `SIMPLER_GRANTS_API_KEY`

- **Templates**:
  - `.env.example:830` = `<REPLACE_ME>`
  - `backend/.env.example:799` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/connectorIngestService.js:L435` (process.env)
  - `backend/services/connectors/grantsGovConnector.js:L174` (process.env)
  - `backend/services/diagnosticsService.js:L404` (process.env)
  - `backend/services/shared/grantsGovClient.js:L34` (process.env)
  - `backend/src/config/apiKeys.js:L48` (env helper)
  - `tests/unit/funding-api-keys.test.mjs:L18–L31` (process.env)

### `SKIP_NETWORK_TESTS`

- **Templates**:
  - `.env.example:831` = ``
  - `backend/.env.example:800` = ``
- **Code references**:
  - `tests/unit/known-schools-liveness.test.mjs:L37` (process.env)

### `SMART_MATCHER_INTENT_MODEL`

- **Templates**:
  - `.env.example:832` = ``
  - `backend/.env.example:801` = ``
- **Code references**:
  - `backend/services/smartMatcherIntent.js:L806` (process.env)

### `SMOKE_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:833` = `<REPLACE_ME>`
  - `backend/.env.example:802` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/doctor.mjs:L182` (process.env)
  - `tests/smoke/admin-tools-button-live.spec.mjs:L23` (process.env)

### `SMOKE_API_BASE`

- **Templates**:
  - `.env.example:834` = ``
  - `backend/.env.example:803` = ``
- **Code references**:
  - `scripts/smoke-docs-local.mjs:L17` (process.env)

### `SMOKE_BASE_PATH`

- **Templates**:
  - `.env.example:835` = ``
  - `backend/.env.example:804` = ``
- **Code references**:
  - `scripts/doctor.mjs:L180` (process.env)
  - `scripts/smoke-auth-callback.mjs:L49` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L51` (process.env)
  - `scripts/smoke-login.mjs:L29` (process.env)
  - `scripts/smoke-organization-profile.mjs:L51` (process.env)
  - `scripts/smoke-prod-readonly.mjs:L15` (process.env)
  - `tests/e2e/playwright.config.mjs:L10` (process.env)
  - `tests/smoke/playwright.config.mjs:L5` (process.env)

### `SMOKE_BASE_URL`

- **Templates**:
  - `.env.example:836` = `http://127.0.0.1:8080`
  - `backend/.env.example:805` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/dedupe-profiles.mjs:L28` (process.env)
  - `scripts/runtime-crawl-local.mjs:L79–L143` (process.env)
  - `scripts/smoke-auth-callback.mjs:L17` (process.env)
  - `scripts/smoke-auth-refresh.mjs:L19` (process.env)
  - `scripts/smoke-login.mjs:L16` (process.env)
  - `scripts/smoke-organization-profile.mjs:L19` (process.env)
  - `scripts/smoke-prod-readonly.mjs:L14` (process.env)
  - `tests/e2e/playwright.config.mjs:L7` (process.env)
  - `tests/smoke/playwright.config.mjs:L4` (process.env)

### `SMOKE_CHECK_PROFILE_SCHEMA`

- **Templates**:
  - `.env.example:837` = ``
  - `backend/.env.example:806` = ``
- **Code references**:
  - `scripts/smoke-prod-readonly.mjs:L16` (process.env)

### `SMOKE_DEBUG`

- **Templates**:
  - `.env.example:838` = ``
  - `backend/.env.example:807` = ``
- **Code references**:
  - `scripts/smoke-login.mjs:L58–L72` (process.env)

### `SMOKE_MAX_CLICKS`

- **Templates**:
  - `.env.example:839` = ``
  - `backend/.env.example:808` = ``
- **Code references**:
  - `scripts/doctor.mjs:L186` (process.env)

### `SMOKE_MAX_PER_SELECTOR`

- **Templates**:
  - `.env.example:840` = ``
  - `backend/.env.example:809` = ``
- **Code references**:
  - `scripts/doctor.mjs:L187` (process.env)

### `SMOKE_MAX_ROUTES`

- **Templates**:
  - `.env.example:841` = ``
  - `backend/.env.example:810` = ``
- **Code references**:
  - `scripts/doctor.mjs:L185` (process.env)

### `SMOKE_MODE`

- **Templates**:
  - `.env.example:842` = ``
  - `backend/.env.example:811` = ``
- **Code references**:
  - `backend/services/comprehensiveCrawlerOptimized.js:L582–L602` (process.env)
  - `backend/start.js:L40–L49` (process.env)
  - `backend/tests/testServer.js:L15` (process.env)
  - `tests/e2e/playwright.config.mjs:L39` (process.env)
  - `tests/unit/startup-smoke-mode.test.mjs:L51` (process.env)

### `SMOKE_TARGET_PATH`

- **Templates**:
  - `.env.example:843` = ``
  - `backend/.env.example:812` = ``
- **Code references**:
  - `scripts/smoke-login.mjs:L30` (process.env)

### `SMS_CONSENT_MESSAGE`

- **Templates**:
  - `.env.example:844` = ``
  - `backend/.env.example:813` = ``
- **Code references**:
  - `backend/services/comms/smsConsentService.js:L60` (process.env)

### `SMS_CONSENT_PENDING_EXPIRE_DAYS`

- **Templates**:
  - `.env.example:845` = ``
  - `backend/.env.example:814` = ``
- **Code references**:
  - `backend/services/comms/smsConsentService.js:L372` (process.env)

### `SMTP_HOST`

- **Templates**:
  - `.env.example:846` = ``
  - `backend/.env.example:815` = ``
- **Code references**:
  - `backend/tests/onboardingRoute.test.js:L189` (process.env)

### `SOURCE`

- **Templates**:
  - `.env.example:847` = ``
  - `backend/.env.example:816` = ``
- **Code references**:
  - `scripts/db-top-tags.cjs:L4` (process.env)

### `SOURCE_URL_REPAIR_BOOT_LIMIT`

- **Templates**:
  - `.env.example:848` = ``
  - `backend/.env.example:817` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4562` (process.env)

### `SOURCE_URL_REPAIR_COOLDOWN_MS`

- **Templates**:
  - `.env.example:849` = ``
  - `backend/.env.example:818` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4565` (process.env)

### `SOURCE_URL_REPAIR_MAX_ATTEMPTS`

- **Templates**:
  - `.env.example:850` = ``
  - `backend/.env.example:819` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4564` (process.env)

### `SOURCE_URL_REPAIR_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:851` = ``
  - `backend/.env.example:820` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L4563` (process.env)

### `SQLITE_BUSY_TIMEOUT_MS`

- **Templates**:
  - `.env.example:852` = ``
  - `backend/.env.example:821` = ``
- **Code references**:
  - `backend/db/index.js:L405` (process.env)
  - `backend/tests/opportunityIdentityStore.test.js:L487–L494` (process.env)

### `SQLITE_CACHE_SIZE_KB`

- **Templates**:
  - `.env.example:853` = ``
  - `backend/.env.example:822` = ``
- **Code references**:
  - `backend/db/index.js:L408` (process.env)

### `SQLITE_DB_PATH`

- **Templates**:
  - `.env.example:854` = `backend/data/grantflow.dev.db`
  - `backend/.env.example:823` = `backend/data/grantflow.dev.db`
- **Code references**:
  - `backend/db/index.js:L115` (process.env)
  - `backend/scripts/migrate-sqlite-to-postgres.mjs:L312` (process.env)
  - `backend/scripts/run-full-system-test.mjs:L163` (process.env)
  - `backend/scripts/verify-real-opps-dataset-fallback.mjs:L7` (process.env)
  - `backend/scripts/verify-snapshot-persistence.mjs:L10` (process.env)
  - `backend/start.js:L66` (process.env)
  - `backend/tests/testServer.js:L20` (process.env)
  - `scripts/audit-section-metadata.mjs:L71` (process.env)
  - `scripts/backfill-opportunity-fields.mjs:L42` (process.env)

### `SQLITE_PATH`

- **Templates**:
  - `.env.example:855` = ``
  - `backend/.env.example:824` = ``
- **Code references**:
  - `scripts/probe-deferred-rcs.mjs:L22` (process.env)

### `STALE_MISSING_FIELD_PROFILE_LIMIT`

- **Templates**:
  - `.env.example:856` = ``
  - `backend/.env.example:825` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L1839` (process.env)

### `STARTUP_PROFILE_JOB_REPAIR_LIMIT`

- **Templates**:
  - `.env.example:857` = ``
  - `backend/.env.example:826` = ``
- **Code references**:
  - `backend/startup/selfHeal.js:L167` (process.env)

### `STARTUP_PROFILE_ORG_LINK_LIMIT`

- **Templates**:
  - `.env.example:858` = ``
  - `backend/.env.example:827` = ``
- **Code references**:
  - `backend/server.js:L1376` (process.env)
  - `backend/startup/selfHeal.js:L143` (process.env)

### `STARTUP_SMOKE_CRAWL_ENABLED`

- **Templates**:
  - `.env.example:859` = ``
  - `backend/.env.example:828` = ``
- **Code references**:
  - `backend/server.js:L3587` (process.env)
  - `backend/startup/backgroundServices.js:L191` (process.env)

### `STRIPE_MOCK`

- **Templates**:
  - `.env.example:860` = ``
  - `backend/.env.example:829` = ``
- **Code references**:
  - `backend/services/pricing/stripePriceVerifier.js:L37` (process.env)
  - `backend/services/stripeService.js:L53–L142` (process.env)
  - `tests/unit/charge-resolver.test.mjs:L16` (process.env)
  - `tests/unit/sam-pricing-stripe-auditor.test.mjs:L15` (process.env)
  - `tests/unit/stripe-price-verifier.test.mjs:L11` (process.env)

### `STRIPE_SECRET_KEY`

- **Templates**:
  - `.env.example:861` = `<REPLACE_ME>`
  - `backend/.env.example:830` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/billing/invoiceService.js:L170–L256` (process.env)
  - `backend/services/pricing/stripePriceVerifier.js:L41` (process.env)
  - `backend/services/stripeService.js:L11` (process.env)

### `STRIPE_WEBHOOK_SECRET`

- **Templates**:
  - `.env.example:862` = `<REPLACE_ME>`
  - `backend/.env.example:831` = `<REPLACE_ME>`
- **Code references**:
  - `backend/services/stripeService.js:L16–L173` (process.env)

### `SWEEP_DEBUG`

- **Templates**:
  - `.env.example:863` = ``
  - `backend/.env.example:832` = ``
- **Code references**:
  - `backend/tests/endpointSweep.test.js:L95` (process.env)

### `Sam_gov_key`

- **Templates**:
  - `.env.example:864` = `<REPLACE_ME>`
  - `backend/.env.example:833` = `<REPLACE_ME>`
- **Code references**:
  - `backend/config/grantsGovEndpoints.js:L49` (process.env)
  - `backend/src/config/apiKeys.js:L42` (env helper)
  - `backend/tests/samDiscoveryAwareness.test.js:L229` (process.env)
  - `backend/tests/samGovApiKey.test.js:L14–L67` (process.env)

### `TEST_API_URL`

- **Templates**:
  - `.env.example:865` = `http://127.0.0.1:8080`
  - `backend/.env.example:834` = `http://127.0.0.1:8080`
- **Code references**:
  - `tests/integration/grants-from-opportunity.test.mjs:L22–L115` (process.env)
  - `tests/manual/test-from-opportunity-comprehensive.mjs:L9` (process.env)

### `TEST_CONCURRENCY`

- **Templates**:
  - `.env.example:866` = ``
  - `backend/.env.example:835` = ``
- **Code references**:
  - `scripts/run-unit-tests.mjs:L40` (process.env)

### `TEST_STATE`

- **Templates**:
  - `.env.example:867` = ``
  - `backend/.env.example:836` = ``
- **Code references**:
  - `scripts/opportunities-national-minimum.mjs:L140` (process.env)

### `TEST_ZIP`

- **Templates**:
  - `.env.example:868` = ``
  - `backend/.env.example:837` = ``
- **Code references**:
  - `backend/tests/testServer.js:L94` (process.env)

### `TWILIO_ACCOUNT_SID`

- **Templates**:
  - `.env.example:869` = `<REPLACE_ME>`
  - `backend/.env.example:838` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/auth.js:L196` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L34` (process.env)
  - `backend/services/diagnosticsService.js:L417` (process.env)
  - `backend/services/sms.js:L20–L29` (process.env)
  - `backend/tests/smsSendHonesty.test.js:L22` (process.env)

### `TWILIO_AUTH_TOKEN`

- **Templates**:
  - `.env.example:870` = `<REPLACE_ME>`
  - `backend/.env.example:839` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/auth.js:L197` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L35` (process.env)
  - `backend/services/diagnosticsService.js:L417` (process.env)
  - `backend/services/sms.js:L21–L30` (process.env)
  - `backend/tests/smsSendHonesty.test.js:L23` (process.env)

### `TWILIO_FROM_NUMBER`

- **Templates**:
  - `.env.example:871` = ``
  - `backend/.env.example:840` = ``
- **Code references**:
  - `backend/routes/auth.js:L199` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L42` (process.env)
  - `backend/services/sms.js:L23–L40` (process.env)
  - `backend/tests/smsSendHonesty.test.js:L24` (process.env)

### `TWILIO_MESSAGING_SERVICE_SID`

- **Templates**:
  - `.env.example:872` = ``
  - `backend/.env.example:841` = ``
- **Code references**:
  - `backend/routes/auth.js:L198` (process.env)
  - `backend/services/deadlineEmailSmsService.js:L42–L118` (process.env)
  - `backend/services/sms.js:L22–L99` (process.env)

### `UNCONFIGURED_PROFILE_PURGE_LIMIT`

- **Templates**:
  - `.env.example:873` = ``
  - `backend/.env.example:842` = ``
- **Code references**:
  - `backend/tests/unconfiguredProfileHonesty.test.js:L370–L506` (process.env)

### `UNIT_TEST_CONCURRENCY`

- **Templates**:
  - `.env.example:874` = ``
  - `backend/.env.example:843` = ``
- **Code references**:
  - `scripts/run-unit-tests.mjs:L40` (process.env)

### `UNIT_TEST_HARD_TIMEOUT_MS`

- **Templates**:
  - `.env.example:875` = ``
  - `backend/.env.example:844` = ``
- **Code references**:
  - `scripts/run-unit-tests.mjs:L65` (process.env)

### `UPLOADS_DIR`

- **Templates**:
  - `.env.example:876` = ``
  - `backend/.env.example:845` = ``
- **Code references**:
  - `backend/routes/health.js:L377` (process.env)
  - `backend/server.js:L367` (process.env)
  - `backend/services/anyaOrchestrator.js:L1741` (process.env)
  - `backend/services/hamilton/hamiltonAutopilotEngine.js:L820` (process.env)
  - `backend/services/maintenance/diskUsage.js:L30` (process.env)
  - `backend/startup/bootstrap.js:L49` (process.env)
  - `backend/tests/hamiltonConfirmationProof.test.js:L115–L619` (process.env)
  - `backend/tests/hamiltonSubmissionAuthority.test.js:L64–L195` (process.env)
  - `backend/utils/uploadsPath.js:L24–L25` (process.env)
  - `tests/unit/release-hardening.test.mjs:L35–L44` (process.env)

### `UPLOADS_ORPHAN_GRACE_HOURS`

- **Templates**:
  - `.env.example:877` = ``
  - `backend/.env.example:846` = ``
- **Code references**:
  - `backend/services/maintenance/pruneDiskArtifacts.js:L186` (process.env)

### `UPLOADS_ORPHAN_PRUNE_ENABLED`

- **Templates**:
  - `.env.example:878` = ``
  - `backend/.env.example:847` = ``
- **Code references**:
  - `backend/services/maintenance/pruneDiskArtifacts.js:L181` (process.env)

### `UPLOADS_PERSIST_PREFIXES`

- **Templates**:
  - `.env.example:879` = ``
  - `backend/.env.example:848` = ``
- **Code references**:
  - `backend/utils/uploadsPath.js:L38` (process.env)

### `UPLOAD_DIR`

- **Templates**:
  - `.env.example:880` = ``
  - `backend/.env.example:849` = ``
- **Code references**:
  - `scripts/dev-start-geo-crawl.mjs:L40–L41` (process.env)

### `URL_RESCUE_BOOT_LIMIT`

- **Templates**:
  - `.env.example:881` = ``
  - `backend/.env.example:850` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2628` (process.env)
  - `backend/tests/enforceInvariants.test.js:L3278–L3396` (process.env)

### `URL_RESCUE_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:882` = ``
  - `backend/.env.example:851` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2629` (process.env)
  - `backend/tests/enforceInvariants.test.js:L3279` (process.env)

### `URL_VERIFICATION_ENABLED`

- **Templates**:
  - `.env.example:883` = ``
  - `backend/.env.example:852` = ``
- **Code references**:
  - `backend/server.js:L309–L339` (process.env)
  - `backend/services/opportunityInserter.js:L162` (process.env)
  - `backend/startup/bootstrap.js:L419–L446` (process.env)

### `USER_PROFILE_MAPPINGS_FILE`

- **Templates**:
  - `.env.example:884` = ``
  - `backend/.env.example:853` = ``
- **Code references**:
  - `backend/config/userProfileMappings.js:L63` (process.env)

### `USER_PROFILE_MAPPINGS_JSON`

- **Templates**:
  - `.env.example:885` = ``
  - `backend/.env.example:854` = ``
- **Code references**:
  - `backend/config/userProfileMappings.js:L64` (process.env)

### `VEHICLES_INGEST_TOKEN`

- **Templates**:
  - `.env.example:886` = `<REPLACE_ME>`
  - `backend/.env.example:855` = `<REPLACE_ME>`
- **Code references**:
  - `backend/routes/vehicles.js:L36` (process.env)

### `VERCEL`

- **Templates**:
  - `.env.example:887` = ``
  - `backend/.env.example:856` = ``
- **Code references**:
  - `backend/routes/health.js:L81` (process.env)
  - `backend/services/productionAuditSnapshot.js:L443` (process.env)
  - `scripts/ensure-build-natives.mjs:L90` (process.env)

### `VERCEL_ENV`

- **Templates**:
  - `.env.example:888` = ``
  - `backend/.env.example:857` = ``
- **Code references**:
  - `backend/routes/auth.js:L486` (process.env)
  - `backend/tests/otpLoginRetired.test.js:L67` (process.env)
  - `backend/utils/environment.js:L14–L24` (process.env)

### `VERCEL_GIT_COMMIT_SHA`

- **Templates**:
  - `.env.example:889` = ``
  - `backend/.env.example:858` = ``
- **Code references**:
  - `backend/routes/health.js:L74` (process.env)
  - `backend/server.js:L2450` (process.env)
  - `backend/services/productionAuditSnapshot.js:L440` (process.env)
  - `backend/startup/backgroundServices.js:L419` (process.env)
  - `backend/utils/observability.js:L32` (process.env)
  - `src/utils/observability.js:L29` (import.meta.env)

### `VERIFICATION_CACHE_MAX_ENTRIES`

- **Templates**:
  - `.env.example:890` = ``
  - `backend/.env.example:859` = ``
- **Code references**:
  - `backend/services/verification/verificationCache.js:L21` (process.env)

### `VERIFICATION_CACHE_TTL_MS`

- **Templates**:
  - `.env.example:891` = ``
  - `backend/.env.example:860` = ``
- **Code references**:
  - `backend/services/verification/verificationConfig.js:L61` (env helper)

### `VERIFIED_AT_HONESTY_BOOT_LIMIT`

- **Templates**:
  - `.env.example:892` = ``
  - `backend/.env.example:861` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2467` (process.env)

### `VERIFIED_AT_HONESTY_TIME_BUDGET_MS`

- **Templates**:
  - `.env.example:893` = ``
  - `backend/.env.example:862` = ``
- **Code references**:
  - `backend/startup/enforceInvariants.js:L2471` (process.env)

### `VERIFY_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:894` = `<REPLACE_ME>`
  - `backend/.env.example:863` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/verification/geo-crawl-5zips.mjs:L19` (process.env)
  - `scripts/verification/health-verify.mjs:L20` (process.env)
  - `scripts/verification/uploads-persistence.mjs:L18` (process.env)
  - `scripts/verify-login.mjs:L5` (process.env)

### `VERIFY_BACKEND_BASE_URL`

- **Templates**:
  - `.env.example:895` = `http://127.0.0.1:8080`
  - `backend/.env.example:864` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/verification/geo-crawl-5zips.mjs:L18` (process.env)
  - `scripts/verification/health-verify.mjs:L19` (process.env)
  - `scripts/verification/owner-profile-access.mjs:L33` (env helper)
  - `scripts/verification/uploads-persistence.mjs:L17` (process.env)

### `VERIFY_BASE_URL`

- **Templates**:
  - `.env.example:896` = `http://127.0.0.1:8080`
  - `backend/.env.example:865` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/verify-login.mjs:L4` (process.env)

### `VERIFY_DB_PATH`

- **Templates**:
  - `.env.example:897` = ``
  - `backend/.env.example:866` = ``
- **Code references**:
  - `scripts/verification/db-evidence.mjs:L4` (process.env)
  - `scripts/verification/geo-crawl-5zips.mjs:L20` (process.env)
  - `scripts/verification/health-verify.mjs:L21` (process.env)
  - `scripts/verification/orphans-evidence.mjs:L4` (process.env)
  - `scripts/verification/profiles-integrity.mjs:L14` (process.env)

### `VERIFY_GEO_RUN_ID`

- **Templates**:
  - `.env.example:898` = ``
  - `backend/.env.example:867` = ``
- **Code references**:
  - `scripts/verification/ui-geocrawl-monitor.mjs:L20` (process.env)

### `VERIFY_PROFILE_ID`

- **Templates**:
  - `.env.example:899` = ``
  - `backend/.env.example:868` = ``
- **Code references**:
  - `scripts/verification/ui-health.mjs:L21` (process.env)
  - `scripts/verification/uploads-persistence.mjs:L19` (process.env)

### `VERIFY_REATTACH_ADMIN_USER_ID`

- **Templates**:
  - `.env.example:900` = ``
  - `backend/.env.example:869` = ``
- **Code references**:
  - `scripts/verify-reattach.mjs:L19` (env helper)

### `VERIFY_REATTACH_DB_PATH`

- **Templates**:
  - `.env.example:901` = ``
  - `backend/.env.example:870` = ``
- **Code references**:
  - `scripts/verify-reattach.mjs:L18` (env helper)

### `VERIFY_REATTACH_OUTPUT_PATH`

- **Templates**:
  - `.env.example:902` = ``
  - `backend/.env.example:871` = ``
- **Code references**:
  - `scripts/verify-reattach.mjs:L20` (env helper)

### `VERIFY_UI_BASE_URL`

- **Templates**:
  - `.env.example:903` = `http://127.0.0.1:8080`
  - `backend/.env.example:872` = `http://127.0.0.1:8080`
- **Code references**:
  - `scripts/verification/ui-geocrawl-monitor.mjs:L18` (process.env)
  - `scripts/verification/ui-health.mjs:L19` (process.env)
  - `scripts/verification/ui-missing-profiles-admin.mjs:L14` (process.env)
  - `scripts/verification/ui-paymentsheet.mjs:L16` (process.env)

### `VERIFY_UI_OUT_DIR`

- **Templates**:
  - `.env.example:904` = ``
  - `backend/.env.example:873` = ``
- **Code references**:
  - `scripts/verification/ui-geocrawl-monitor.mjs:L19` (process.env)
  - `scripts/verification/ui-health.mjs:L20` (process.env)
  - `scripts/verification/ui-missing-profiles-admin.mjs:L15` (process.env)
  - `scripts/verification/ui-paymentsheet.mjs:L17` (process.env)

### `VITEST`

- **Templates**:
  - `.env.example:905` = ``
  - `backend/.env.example:874` = ``
- **Code references**:
  - `backend/services/amy/repoRewardsScout.js:L58` (process.env)

### `VITE_ANYA_COPILOT_ENABLED`

- **Templates**:
  - `.env.example:16` = ``
- **Code references**:
  - `src/config/env.js:L40` (import.meta.env)

### `VITE_ANYA_SCREENSHOT_ENABLED`

- **Templates**:
  - `.env.example:17` = ``
- **Code references**:
  - `src/config/env.js:L41` (import.meta.env)

### `VITE_API_URL`

- **Templates**:
  - `.env.example:18` = ``
- **Code references**:
  - `src/api/client.js:L16` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L129–L131` (import.meta.env)
  - `src/config/env.js:L35` (import.meta.env)

### `VITE_APP_BASE`

- **Templates**:
  - `.env.example:19` = `/grantflow`
- **Code references**:
  - `backend/routes/auth.js:L204` (process.env)
  - `backend/server.js:L270–L708` (process.env)
  - `scripts/doctor.mjs:L81–L180` (process.env)
  - `src/components/auth/SessionExpiredDialog.jsx:L12` (import.meta.env)
  - `src/components/auth/SocialSignInButtons.jsx:L25` (import.meta.env)
  - `src/config/env.js:L34` (import.meta.env)
  - `src/utils/enforceBasename.js:L13` (import.meta.env)
  - `src/utils/index.js:L27` (import.meta.env)
  - `tests/e2e/playwright.config.mjs:L10` (process.env)
  - `tests/helpers/backendHarness.mjs:L84` (process.env)
  - `tests/smoke/playwright.config.mjs:L5` (process.env)
  - `tests/unit/anya-background-reply.test.mjs:L48` (process.env)
  - `tests/unit/anya-tasks.test.mjs:L58` (process.env)
  - `tests/unit/api-contracts.test.mjs:L79` (process.env)

### `VITE_ASSET_BASE`

- **Templates**:
  - `.env.example:20` = ``
- **Code references**:
  - `scripts/doctor.mjs:L169` (process.env)

### `VITE_CANONICAL_HOST`

- **Templates**:
  - `.env.example:21` = ``
- **Code references**:
  - `src/config/env.js:L37` (import.meta.env)
  - `src/utils/enforceCanonicalHost.js:L6` (import.meta.env)

### `VITE_CANONICAL_HOST_STRICT`

- **Templates**:
  - `.env.example:22` = ``
- **Code references**:
  - `src/config/env.js:L38` (import.meta.env)
  - `src/utils/enforceCanonicalHost.js:L11` (import.meta.env)

### `VITE_DEV_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:23` = `<REPLACE_ME>`
- **Code references**:
  - `src/pages/Login.jsx:L94` (import.meta.env)

### `VITE_ENABLE_CLICK_TRACER`

- **Templates**:
  - `.env.example:24` = ``
- **Code references**:
  - `src/components/shared/clickTracer.jsx:L5` (import.meta.env)

### `VITE_ENABLE_CLIENT_LOGS`

- **Templates**:
  - `.env.example:25` = ``
- **Code references**:
  - `src/utils/logger.js:L15` (import.meta.env)

### `VITE_FORCE_RAILWAY_API`

- **Templates**:
  - `.env.example:26` = ``
- **Code references**:
  - `src/components/auth/SocialSignInButtons.jsx:L127` (import.meta.env)
  - `src/config/env.js:L42–L117` (import.meta.env)

### `VITE_PREVIEW_API_URL`

- **Templates**:
  - `.env.example:28` = `http://127.0.0.1:8080`
- **Code references**:
  - `src/config/env.js:L36` (import.meta.env)

### `VITE_SENTRY_DSN`

- **Templates**:
  - `.env.example:29` = ``
- **Code references**:
  - `src/utils/observability.js:L21` (import.meta.env)

### `VITE_SENTRY_ENVIRONMENT`

- **Templates**:
  - `.env.example:30` = ``
- **Code references**:
  - `src/utils/observability.js:L26` (import.meta.env)

### `VITE_SENTRY_RELEASE`

- **Templates**:
  - `.env.example:31` = ``
- **Code references**:
  - `src/utils/observability.js:L28` (import.meta.env)

### `VITE_SENTRY_TRACES_SAMPLE_RATE`

- **Templates**:
  - `.env.example:32` = ``
- **Code references**:
  - `src/utils/observability.js:L31` (import.meta.env)

### `VITE_SHOULDERS_VNEXT`

- **Templates**:
  - `.env.example:33` = ``
- **Code references**:
  - `src/config/env.js:L39` (import.meta.env)

### `VITE_SMOKE_MODE`

- **Templates**:
  - `.env.example:34` = ``
- **Code references**:
  - `tests/e2e/playwright.config.mjs:L40` (process.env)

### `VITE_SUPPORT_EMAIL`

- **Templates**:
  - `.env.example:35` = ``
- **Code references**:
  - `src/pages/Pricing.jsx:L310–L313` (import.meta.env)

### `VITE_SUPPORT_FAX`

- **Templates**:
  - `.env.example:36` = ``
- **Code references**:
  - `src/pages/Pricing.jsx:L318` (import.meta.env)

### `WARM_COUNTY_CACHE`

- **Templates**:
  - `.env.example:906` = ``
  - `backend/.env.example:875` = ``
- **Code references**:
  - `backend/startup/warmCountyCache.js:L92` (process.env)
  - `backend/tests/warmCountyCache.test.js:L54–L62` (process.env)

### `WEB_DISCOVERY_ENABLED`

- **Templates**:
  - `.env.example:907` = ``
  - `backend/.env.example:876` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L215` (process.env)
  - `backend/tests/specificNeedRoute.test.js:L127–L253` (process.env)

### `WEB_DISCOVERY_MODEL_ANTHROPIC`

- **Templates**:
  - `.env.example:908` = ``
  - `backend/.env.example:877` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L318` (process.env)
  - `backend/services/webGrantExtractor.js:L72` (process.env)

### `WEB_DISCOVERY_MODEL_OPENAI`

- **Templates**:
  - `.env.example:909` = ``
  - `backend/.env.example:878` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L319` (process.env)
  - `backend/services/webGrantExtractor.js:L73` (process.env)

### `WEB_LANE_MAX_PAGES`

- **Templates**:
  - `.env.example:910` = ``
  - `backend/.env.example:879` = ``
- **Code references**:
  - `backend/crawler-os/webLane.js:L470` (process.env)

### `WEB_LANE_MAX_QUERIES`

- **Templates**:
  - `.env.example:911` = ``
  - `backend/.env.example:880` = ``
- **Code references**:
  - `backend/crawler-os/webLane.js:L466` (process.env)
  - `backend/tests/webLane.test.js:L185–L193` (process.env)

### `WEB_LANE_PROFILE_BLIND`

- **Templates**:
  - `.env.example:912` = ``
  - `backend/.env.example:881` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L228` (process.env)

### `WEB_LANE_PROFILE_BLIND_MAX_PAGES`

- **Templates**:
  - `.env.example:913` = ``
  - `backend/.env.example:882` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L328` (process.env)

### `WEB_LANE_PROFILE_BLIND_TIMEOUT_MS`

- **Templates**:
  - `.env.example:914` = ``
  - `backend/.env.example:883` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L330` (process.env)

### `WEB_LANE_PROFILE_BLIND_TOTAL_BUDGET_MS`

- **Templates**:
  - `.env.example:915` = ``
  - `backend/.env.example:884` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L329` (process.env)

### `WEB_LANE_RESULTS_PER_QUERY`

- **Templates**:
  - `.env.example:916` = ``
  - `backend/.env.example:885` = ``
- **Code references**:
  - `backend/crawler-os/webLane.js:L468` (process.env)

### `WEB_LANE_TARGET_VERIFY_BUDGET_MS`

- **Templates**:
  - `.env.example:917` = ``
  - `backend/.env.example:886` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L334` (process.env)

### `WEB_LANE_TARGET_VERIFY_MAX`

- **Templates**:
  - `.env.example:918` = ``
  - `backend/.env.example:887` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L335` (process.env)

### `WEB_LANE_TARGET_VERIFY_TIMEOUT_MS`

- **Templates**:
  - `.env.example:919` = ``
  - `backend/.env.example:888` = ``
- **Code references**:
  - `backend/services/crawlerOsService.js:L338` (process.env)

### `WEB_PARITY_BENCHMARK`

- **Templates**:
  - `.env.example:920` = ``
  - `backend/.env.example:889` = ``
- **Code references**:
  - `backend/services/webParityBenchmark.js:L332` (process.env)
  - `backend/tests/webParityBenchmark.test.js:L119–L661` (process.env)

### `WEB_SEARCH_CACHE_TTL_HOURS`

- **Templates**:
  - `.env.example:921` = ``
  - `backend/.env.example:890` = ``
- **Code references**:
  - `backend/services/shared/webSearchCache.js:L43` (process.env)
  - `backend/tests/webSearchCache.test.js:L35–L70` (process.env)

### `WEEKLY_VERIFY_CHUNKS`

- **Templates**:
  - `.env.example:922` = ``
  - `backend/.env.example:891` = ``
- **Code references**:
  - `backend/server.js:L3870` (process.env)

### `X_ADMIN_TOKEN`

- **Templates**:
  - `.env.example:923` = `<REPLACE_ME>`
  - `backend/.env.example:892` = `<REPLACE_ME>`
- **Code references**:
  - `scripts/smoke-docs-local.mjs:L18` (process.env)

### `YANA_ALLOW_LIVE_WEB`

- **Templates**:
  - `.env.example:924` = ``
  - `backend/.env.example:893` = ``
- **Code references**:
  - `backend/server.js:L3145` (process.env)

### `YANA_BACKLOG_ENRICH_LIMIT`

- **Templates**:
  - `.env.example:925` = ``
  - `backend/.env.example:894` = ``
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L1059` (process.env)

### `YANA_BACKLOG_ENRICH_MAX_ATTEMPTS`

- **Templates**:
  - `.env.example:926` = ``
  - `backend/.env.example:895` = ``
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L747` (process.env)

### `YANA_CAP_WINDOW_HOURS`

- **Templates**:
  - `.env.example:927` = ``
  - `backend/.env.example:896` = ``
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L63` (process.env)

### `YANA_DAILY_LEAD_CAP`

- **Templates**:
  - `.env.example:928` = ``
  - `backend/.env.example:897` = ``
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L62` (process.env)

### `YANA_ENABLED`

- **Templates**:
  - `.env.example:929` = ``
  - `backend/.env.example:898` = ``
- **Code references**:
  - `backend/services/sam/samRegistry.js:L2080` (process.env)
  - `backend/tests/yanaScheduler.test.js:L96` (process.env)
  - `tests/unit/yana-leads-scheduler.test.mjs:L83` (process.env)

### `YANA_ENRICH_CONCURRENCY`

- **Templates**:
  - `.env.example:930` = ``
  - `backend/.env.example:899` = ``
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L213` (process.env)

### `YANA_EXCLUDED_DOMAINS`

- **Templates**:
  - `.env.example:931` = ``
  - `backend/.env.example:900` = ``
- **Code references**:
  - `backend/services/yana/prospectExclusions.js:L43` (env helper)

### `YANA_HARVEST_VERIFY_LIMIT`

- **Templates**:
  - `.env.example:932` = ``
  - `backend/.env.example:901` = ``
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L1120` (process.env)

### `YANA_LEADS_ENABLED`

- **Templates**:
  - `.env.example:933` = ``
  - `backend/.env.example:902` = ``
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L153–L175` (process.env)

### `YANA_LEADS_RUN_ON_SCHEDULE`

- **Templates**:
  - `.env.example:934` = ``
  - `backend/.env.example:903` = ``
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L154–L176` (process.env)

### `YANA_LEADS_RUN_ON_STARTUP`

- **Templates**:
  - `.env.example:935` = ``
  - `backend/.env.example:904` = ``
- **Code references**:
  - `tests/unit/yana-leads-scheduler.test.mjs:L155–L177` (process.env)

### `YANA_OSM_USER_AGENT`

- **Templates**:
  - `.env.example:936` = ``
  - `backend/.env.example:905` = ``
- **Code references**:
  - `backend/services/yana/osmProvider.js:L28` (process.env)

### `YANA_QUALIFY_THRESHOLD`

- **Templates**:
  - `.env.example:937` = ``
  - `backend/.env.example:906` = ``
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L57` (process.env)

### `YANA_RESEARCH_STATES`

- **Templates**:
  - `.env.example:938` = ``
  - `backend/.env.example:907` = ``
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L630` (process.env)

### `YANA_RUN_ON_SCHEDULE`

- **Templates**:
  - `.env.example:939` = ``
  - `backend/.env.example:908` = ``
- **Code references**:
  - `backend/tests/yanaScheduler.test.js:L98` (process.env)

### `YANA_RUN_ON_STARTUP`

- **Templates**:
  - `.env.example:940` = ``
  - `backend/.env.example:909` = ``
- **Code references**:
  - `backend/tests/yanaScheduler.test.js:L97` (process.env)

### `YANA_TARGET_AREAS`

- **Templates**:
  - `.env.example:941` = `Bradley County, TN; Lorain County, OH; Erie County, OH`
  - `backend/.env.example:910` = `Bradley County, TN; Lorain County, OH; Erie County, OH`
- **Code references**:
  - `backend/services/yana/yanaLeadDiscovery.js:L516` (process.env)

### `YANA_WEB_CSV_FEED_URL`

- **Templates**:
  - `.env.example:942` = `http://127.0.0.1:8080`
  - `backend/.env.example:911` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/yana/yanaWebCrawler.js:L411` (process.env)

### `YANA_WEB_JSON_FEED_URL`

- **Templates**:
  - `.env.example:943` = `http://127.0.0.1:8080`
  - `backend/.env.example:912` = `http://127.0.0.1:8080`
- **Code references**:
  - `backend/services/yana/yanaWebCrawler.js:L398` (process.env)

### `ZIP_COUNTY_MAP_PATH`

- **Templates**:
  - `.env.example:944` = ``
  - `backend/.env.example:913` = ``
- **Code references**:
  - `backend/services/geo/zipCountyResolver.js:L15–L15` (process.env)

### `npm_package_version`

- **Templates**:
  - `.env.example:945` = ``
  - `backend/.env.example:914` = ``
- **Code references**:
  - `backend/routes/anya.js:L136` (process.env)
  - `backend/routes/health.js:L534` (process.env)
