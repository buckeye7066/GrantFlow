-- EVA (End-user Validation Agent) portfolio user-journey QA — persistence.
-- SQLite parity: backend/db/migrations/151_eva_portfolio_qa.sql
--
-- ADDITIVE, default-off. Postgres twin of the EVA persistence schema. No
-- BOOLEAN columns by design (see the SQLite twin's DESIGN NOTE): lifecycle and
-- status are TEXT, and nothing filters on 0/1, so the KNOWN_BOOLEAN_COLUMNS
-- shim is never engaged. TIMESTAMPTZ DEFAULT now() mirrors the SQLite
-- DATETIME DEFAULT CURRENT_TIMESTAMP. CREATE ... IF NOT EXISTS is idempotent.

CREATE TABLE IF NOT EXISTS eva_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  runner_version TEXT,
  environment TEXT NOT NULL,
  is_catchup INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT,
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

CREATE TABLE IF NOT EXISTS eva_app_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  display_name TEXT,
  repo TEXT,
  commit_sha TEXT,
  app_status TEXT NOT NULL,
  blocker_reason TEXT,
  duration_ms INTEGER DEFAULT 0,
  features_total INTEGER DEFAULT 0,
  features_covered INTEGER DEFAULT 0,
  unautomated_features_json TEXT,
  journeys_total INTEGER DEFAULT 0,
  journeys_passed INTEGER DEFAULT 0,
  journeys_failed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eva_app_runs_run ON eva_app_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_eva_app_runs_app ON eva_app_runs(app_id);

CREATE TABLE IF NOT EXISTS eva_journey_results (
  id TEXT PRIMARY KEY,
  app_run_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
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
  fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eva_journey_app_run ON eva_journey_results(app_run_id);
CREATE INDEX IF NOT EXISTS idx_eva_journey_fingerprint ON eva_journey_results(fingerprint);
CREATE INDEX IF NOT EXISTS idx_eva_journey_run ON eva_journey_results(run_id);

CREATE TABLE IF NOT EXISTS eva_findings (
  fingerprint TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  display_name TEXT,
  journey_name TEXT,
  failure_class TEXT,
  route_or_control TEXT,
  severity TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'new',
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
  latest_journey_result_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eva_findings_state ON eva_findings(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_eva_findings_app ON eva_findings(app_id);

CREATE TABLE IF NOT EXISTS eva_runner_heartbeats (
  runner_id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL,
  runner_version TEXT,
  status TEXT,
  note TEXT,
  hostname_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eva_evidence (
  id TEXT PRIMARY KEY,
  journey_result_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha256 TEXT,
  bytes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eva_evidence_journey ON eva_evidence(journey_result_id);
