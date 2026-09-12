-- 0191_agent_control_lock_instance_heartbeat.sql (Postgres)
--
-- Stale-lock reclaim across a redeploy/restart. See the SQLite twin
-- (187_agent_control_lock_instance_heartbeat.sql) for the full rationale.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE TABLE/INDEX IF NOT EXISTS,
-- all safe to re-run.

ALTER TABLE agent_control_locks ADD COLUMN IF NOT EXISTS holder_instance_id TEXT;

CREATE TABLE IF NOT EXISTS agent_control_instances (
  instance_id TEXT PRIMARY KEY,
  pid INTEGER,
  hostname TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_control_instances_heartbeat ON agent_control_instances(last_heartbeat_at);
