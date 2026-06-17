-- Agent Mission Control — unified telemetry tables (SQLite).
--
-- These tables are the canonical event/rollup feed for the Mission Control
-- admin dashboard. The aggregator also reads agent-specific tables
-- (anya_*, sam_*, robert_*, yana_*, john_*) when present, but the unified
-- tables are always queried first so the dashboard works the moment any
-- agent emits an event — no per-agent migration coupling required.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS agent_activity_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT,
  severity TEXT,
  title TEXT,
  description TEXT,
  metric_key TEXT,
  metric_value REAL,
  entity_type TEXT,
  entity_id TEXT,
  user_id TEXT,
  profile_id TEXT,
  organization_id TEXT,
  state TEXT,
  county TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  details_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_events_agent_created
  ON agent_activity_events(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_status_created
  ON agent_activity_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_event_type
  ON agent_activity_events(event_type);
CREATE INDEX IF NOT EXISTS idx_agent_events_state
  ON agent_activity_events(state);

CREATE TABLE IF NOT EXISTS agent_daily_rollups (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_name TEXT NOT NULL,
  rollup_date TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value REAL NOT NULL DEFAULT 0,
  details_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_name, rollup_date, metric_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_rollups_agent_date
  ON agent_daily_rollups(agent_name, rollup_date DESC);
