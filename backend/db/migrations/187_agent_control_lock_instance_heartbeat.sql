-- 187_agent_control_lock_instance_heartbeat.sql (SQLite)
--
-- Stale-lock reclaim across a redeploy/restart (2026-09-12).
--
-- A scheduler lock (e.g. scheduler:amy:training) carries only a TTL: while a
-- run is alive it renews its own expires_at, so a Railway redeploy that kills
-- the process mid-run leaves a lock whose *last renewal* already pushed the
-- deadline minutes into the future. The next boot's run then reads
-- acquire.contended / lock_held and cannot start until the stale TTL lapses
-- (observed 2026-09-12: up to ~40 minutes after a redeploy/restart).
--
-- This migration adds the plumbing for reclaiming a lock whose HOLDING
-- PROCESS is provably dead, independent of the lock's own TTL:
--   1. agent_control_locks.holder_instance_id — the acquiring process's boot
--      id, recorded on every acquire/takeover.
--   2. agent_control_instances — a lightweight per-process liveness table,
--      refreshed on a short heartbeat while a process is up.
--
-- agentControlStore.acquireLock() takes over a lock immediately once the
-- recorded holder's instance has no heartbeat newer than a short bound (or no
-- instance row at all) — a live holder (fresh heartbeat) is never touched, so
-- mutual exclusion across multiple live instances is unaffected.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; the boot self-heal
-- (agentControlStore.ensureSchema) tolerates a duplicate-column error, so
-- re-applying this file is harmless.

ALTER TABLE agent_control_locks ADD COLUMN holder_instance_id TEXT;

CREATE TABLE IF NOT EXISTS agent_control_instances (
  instance_id TEXT PRIMARY KEY,
  pid INTEGER,
  hostname TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_heartbeat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_control_instances_heartbeat ON agent_control_instances(last_heartbeat_at);
