-- 099_agent_control_lock_owner_token.sql (SQLite)
--
-- Fenced, self-healing per-agent / full_cycle locks.
--
-- The Agent Control Center locks (agent_control_locks) previously had no
-- owner token: release was scoped only by control_run_id, and a holder that
-- crashed mid-cycle left the row behind until its TTL lapsed — which surfaced
-- as the recurring "Could not acquire lock 'agent_control:agent:<name>'"
-- failure on the Mission Control dashboard.
--
-- This migration:
--   1. adds owner_token so a process can release ONLY the lock it owns, and
--   2. proactively sweeps any already-orphaned (expired) locks so the system
--      recovers on the next deploy without manual intervention.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; the boot self-heal
-- (ensureAgentSubsystemTables / agentControlStore.ensureSchema) tolerates a
-- duplicate-column error, so re-applying this file is harmless.

ALTER TABLE agent_control_locks ADD COLUMN owner_token TEXT;

-- Reclaim locks orphaned by a crash/restart before this fix shipped.
DELETE FROM agent_control_locks
 WHERE expires_at IS NOT NULL
   AND expires_at < CURRENT_TIMESTAMP;
