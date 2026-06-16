-- Agent Mission Control — unified telemetry tables (Postgres).
-- See migrations/084_agent_telemetry.sql for SQLite. Idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agent_activity_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT,
  severity TEXT,
  title TEXT,
  description TEXT,
  metric_key TEXT,
  metric_value DOUBLE PRECISION,
  entity_type TEXT,
  entity_id TEXT,
  user_id TEXT,
  profile_id TEXT,
  organization_id TEXT,
  state TEXT,
  county TEXT,
  city TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  details_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
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
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_name TEXT NOT NULL,
  rollup_date DATE NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value DOUBLE PRECISION NOT NULL DEFAULT 0,
  details_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent_name, rollup_date, metric_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_rollups_agent_date
  ON agent_daily_rollups(agent_name, rollup_date DESC);
