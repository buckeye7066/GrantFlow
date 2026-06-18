-- 0095_agent_control_lock_owner_token.sql (Postgres)
--
-- Fenced, self-healing per-agent / full_cycle locks. See the SQLite twin
-- (099_agent_control_lock_owner_token.sql) for the full rationale.
--
-- The Agent Control Center locks (agent_control_locks) previously had no
-- owner token: release was scoped only by control_run_id, and a holder that
-- crashed mid-cycle (Railway dynos restart frequently and the filesystem is
-- ephemeral) left the row behind until its TTL lapsed — surfacing as the
-- recurring "Could not acquire lock 'agent_control:agent:<name>'" failure.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a bounded sweep, both safe to re-run.

ALTER TABLE agent_control_locks ADD COLUMN IF NOT EXISTS owner_token TEXT;

-- Reclaim locks orphaned by a crash/restart before this fix shipped.
DELETE FROM agent_control_locks
 WHERE expires_at IS NOT NULL
   AND expires_at < now();
