-- EVA (End-user Validation Agent) portfolio user-journey QA — persistence.
-- Twin: backend/db/postgres/migrations/0155_eva_portfolio_qa.sql
--
-- ADDITIVE, default-off. Stores the results of nightly end-user journey tests
-- uploaded by the Windows edge runner, plus deduplicated findings with a stable
-- lifecycle (new/recurring/worsened/intermittent/resolved/blocked/stale) so the
-- Anya morning email can tell the owner what a real user could and could not do
-- overnight without re-screaming yesterday's unchanged low-priority issue.
--
-- DESIGN NOTE (boolean trap avoidance): this schema uses NO BOOLEAN columns and
-- never filters on 0/1 in SQL — lifecycle/status are TEXT, and the postgres shim
-- rewrites `col = 1/0` only for an allowlisted set (KNOWN_BOOLEAN_COLUMNS), so
-- storing state as TEXT sidesteps the `boolean = integer` class entirely.
--
-- CREATE TABLE/INDEX IF NOT EXISTS is idempotent; on a fresh SQLite DB
-- schema.sql already creates these, so the runner records a no-op.

-- One overall EVA run = one edge-runner upload (a batch across many apps).
CREATE TABLE IF NOT EXISTS eva_runs (
  id TEXT PRIMARY KEY,                 -- our surrogate id
  run_id TEXT NOT NULL,                -- runner-supplied run id (idempotency scope)
  runner_id TEXT NOT NULL,
  runner_version TEXT,
  environment TEXT NOT NULL,
  is_catchup INTEGER NOT NULL DEFAULT 0,  -- 0/1 flag, never SQL-filtered
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  idempotency_key TEXT,               -- from signature envelope; dedupes retries
  nonce TEXT,
  apps_expected INTEGER DEFAULT 0,
  apps_tested INTEGER DEFAULT 0,
  journeys_total INTEGER DEFAULT 0,
  journeys_passed INTEGER DEFAULT 0,
  journeys_failed INTEGER DEFAULT 0,
  payload_bytes INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_eva_runs_idempotency
  ON eva_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eva_runs_received ON eva_runs(received_at);

-- Per-application result within a run.
CREATE TABLE IF NOT EXISTS eva_app_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,               -- FK -> eva_runs.id
  app_id TEXT NOT NULL,
  display_name TEXT,
  repo TEXT,
  commit_sha TEXT,
  app_status TEXT NOT NULL,           -- tested|blocked|not_run|startup_failed|source_unavailable|...
  blocker_reason TEXT,
  duration_ms INTEGER DEFAULT 0,
  features_total INTEGER DEFAULT 0,
  features_covered INTEGER DEFAULT 0,
  unautomated_features_json TEXT,
  journeys_total INTEGER DEFAULT 0,
  journeys_passed INTEGER DEFAULT 0,
  journeys_failed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS idx_eva_app_runs_run ON eva_app_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_eva_app_runs_app ON eva_app_runs(app_id);

-- Individual journey result.
CREATE TABLE IF NOT EXISTS eva_journey_results (
  id TEXT PRIMARY KEY,
  app_run_id TEXT NOT NULL,           -- FK -> eva_app_runs.id
  run_id TEXT NOT NULL,               -- denormalized -> eva_runs.id for fast scans
  app_id TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,               -- passed|failed|blocked|skipped
  severity TEXT,
  retry_classification TEXT,
  duration_ms INTEGER DEFAULT 0,
  route_or_control TEXT,
  failure_class TEXT,
  error_signature TEXT,
  expected_behavior TEXT,
  observed_behavior TEXT,
  repro_steps_json TEXT,
  user_impact TEXT,
  likely_root_cause TEXT,
  recommended_fix TEXT,
  candidate_files_json TEXT,
  diagnostic_confidence REAL,
  missing_evidence TEXT,
  evidence_json TEXT,
  fingerprint TEXT,                   -- present on failures; joins to eva_findings
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS idx_eva_journey_app_run ON eva_journey_results(app_run_id);
CREATE INDEX IF NOT EXISTS idx_eva_journey_fingerprint ON eva_journey_results(fingerprint);
CREATE INDEX IF NOT EXISTS idx_eva_journey_run ON eva_journey_results(run_id);

-- Deduplicated finding: one row per stable fingerprint, lifecycle tracked.
CREATE TABLE IF NOT EXISTS eva_findings (
  fingerprint TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  display_name TEXT,
  journey_name TEXT,
  failure_class TEXT,
  route_or_control TEXT,
  severity TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'new',  -- new|recurring|worsened|intermittent|resolved|blocked|stale
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_seen_run_id TEXT,
  last_seen_run_id TEXT,
  recurrence_count INTEGER NOT NULL DEFAULT 1,
  intermittent_count INTEGER NOT NULL DEFAULT 0,
  prior_severity TEXT,
  last_passing_run_id TEXT,
  last_passing_at TEXT,
  resolved_at TEXT,
  resolved_run_id TEXT,
  latest_journey_result_id TEXT,      -- newest eva_journey_results row for detail
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS idx_eva_findings_state ON eva_findings(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_eva_findings_app ON eva_findings(app_id);

-- Runner heartbeat — a runner that cannot test still checks in, so a silent
-- runner surfaces as a stale heartbeat rather than an accidental all-clear.
CREATE TABLE IF NOT EXISTS eva_runner_heartbeats (
  runner_id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL,
  runner_version TEXT,
  status TEXT,                        -- ok|testing|blocked|idle
  note TEXT,
  hostname_hash TEXT,                 -- salted hash, never the raw hostname
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- Evidence metadata (by reference only — never raw log bodies/screenshots).
CREATE TABLE IF NOT EXISTS eva_evidence (
  id TEXT PRIMARY KEY,
  journey_result_id TEXT NOT NULL,    -- FK -> eva_journey_results.id
  kind TEXT NOT NULL,                 -- trace|screenshot|video|console|network|server-log|steps|timing
  ref TEXT NOT NULL,                  -- opaque sanitized reference
  sha256 TEXT,
  bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS idx_eva_evidence_journey ON eva_evidence(journey_result_id);
