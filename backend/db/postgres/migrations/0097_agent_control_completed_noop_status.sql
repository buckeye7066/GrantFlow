-- Allow the honest "ran but persisted no real work" run outcome.
-- The orchestrator now resolves a clean run with zero agent work to
-- 'completed_noop' instead of a hollow 'completed'. The original 0087 CHECK
-- didn't include it. agentControlStore.ensureSchema also self-heals this at
-- boot (driven from RUN_STATUSES) so existing prod DBs accept it immediately;
-- this migration keeps `npm run migrate` / fresh DBs in sync.
ALTER TABLE agent_control_runs DROP CONSTRAINT IF EXISTS agent_control_runs_status_check;
ALTER TABLE agent_control_runs ADD CONSTRAINT agent_control_runs_status_check CHECK (status IN (
  'queued','running','pausing','paused','stopping','stopped',
  'completed','completed_noop','failed','cancelled','partial_stop','stop_failed'
));
