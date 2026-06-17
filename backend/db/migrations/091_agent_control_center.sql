-- 091_agent_control_center.sql
-- @sqlite-continue-on-idempotent-errors
--
-- Admin-only Agent Control Center: persistent orchestration runs that the
-- single canonical admin/operator (buckeye7066@gmail.com) uses to start /
-- stop / pause / resume the whole GrantFlow agent process (Sam, Robert,
-- Yana lead-discovery, John outreach, Hamilton autopilot).
--
-- Idempotent: every CREATE TABLE / INDEX uses IF NOT EXISTS, every column
-- backfill goes through PRAGMA-table_info first, and the migration runner
-- tolerates "duplicate column" errors via the @sqlite-continue-on-idempotent-errors
-- header.

CREATE TABLE IF NOT EXISTS agent_control_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_name TEXT,
  run_type TEXT NOT NULL CHECK(run_type IN (
    'full_cycle',
    'selected_agents',
    'sam_only',
    'robert_only',
    'yana_only',
    'john_only',
    'hamilton_only',
    'scheduled_cycle'
  )),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued',
    'running',
    'pausing',
    'paused',
    'stopping',
    'stopped',
    'completed',
    'failed',
    'cancelled',
    'partial_stop',
    'stop_failed'
  )),
  started_by_user_id TEXT,
  started_by_email TEXT,
  admin_email TEXT NOT NULL DEFAULT 'buckeye7066@gmail.com',
  requested_agents_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '{}',
  cancellation_requested_at DATETIME,
  pause_requested_at DATETIME,
  resume_requested_at DATETIME,
  started_at DATETIME,
  completed_at DATETIME,
  error_message TEXT,
  summary_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_control_runs_status      ON agent_control_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_control_runs_run_type    ON agent_control_runs(run_type);
CREATE INDEX IF NOT EXISTS idx_agent_control_runs_started_at  ON agent_control_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_runs_created_at  ON agent_control_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_runs_admin       ON agent_control_runs(admin_email);

CREATE TABLE IF NOT EXISTS agent_control_steps (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  control_run_id TEXT NOT NULL,
  agent_name TEXT NOT NULL CHECK(agent_name IN (
    'sam', 'robert', 'yana', 'john', 'hamilton'
  )),
  step_name TEXT NOT NULL,
  step_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued',
    'running',
    'paused',
    'stopping',
    'stopped',
    'completed',
    'failed',
    'skipped',
    'blocked'
  )),
  started_at DATETIME,
  completed_at DATETIME,
  heartbeat_at DATETIME,
  cancellation_checked_at DATETIME,
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_control_steps_run        ON agent_control_steps(control_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_control_steps_agent      ON agent_control_steps(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_control_steps_status     ON agent_control_steps(status);
CREATE INDEX IF NOT EXISTS idx_agent_control_steps_run_order  ON agent_control_steps(control_run_id, step_order);

CREATE TABLE IF NOT EXISTS agent_control_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  control_run_id TEXT,
  step_id TEXT,
  agent_name TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN (
    'critical', 'high', 'medium', 'low', 'info'
  )),
  message TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_control_events_run       ON agent_control_events(control_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_events_agent     ON agent_control_events(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_events_type      ON agent_control_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_events_severity  ON agent_control_events(severity, created_at DESC);

-- Per-process locks. The 'agent_control:full_cycle' lock guarantees only
-- one full_cycle can run at a time. Per-agent locks ('agent_control:agent:<name>')
-- guarantee individual runs don't overlap with a full_cycle unless the
-- caller explicitly provides allow_overlap.
CREATE TABLE IF NOT EXISTS agent_control_locks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lock_name TEXT NOT NULL UNIQUE,
  control_run_id TEXT NOT NULL,
  acquired_by TEXT,
  acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_agent_control_locks_run        ON agent_control_locks(control_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_control_locks_expires    ON agent_control_locks(expires_at);

-- Durable stop requests. The orchestrator writes one row per pause/resume/
-- stop/emergency-stop/cancel command; agent runners poll for the latest
-- unfulfilled request between atomic operations. Storing this in a table
-- (not in memory) means a stop survives process restarts and the UI can
-- show what was requested even if the run hasn't yet acknowledged it.
CREATE TABLE IF NOT EXISTS agent_control_stop_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  control_run_id TEXT NOT NULL,
  agent_name TEXT,
  requested_by_email TEXT,
  requested_by_user_id TEXT,
  request_type TEXT NOT NULL CHECK(request_type IN (
    'pause', 'resume', 'graceful_stop', 'emergency_stop', 'cancel'
  )),
  reason TEXT,
  fulfilled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_control_stop_run         ON agent_control_stop_requests(control_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_control_stop_unfulfilled ON agent_control_stop_requests(control_run_id, fulfilled_at);
CREATE INDEX IF NOT EXISTS idx_agent_control_stop_agent       ON agent_control_stop_requests(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_control_stop_type        ON agent_control_stop_requests(request_type);
