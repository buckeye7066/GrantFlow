-- Allow the terminal 'blocked' run outcome: Sam preflight refused to clear the
-- fleet (a critical finding, or in production a preflight that could not
-- execute its critical checks). Its run.error_message and summary.blocked_by
-- NAME the unmet prerequisite and operator action (agentControlOrchestrator,
-- 2026-09-12). Neither the original 0087 CHECK nor 0097 included it.
-- agentControlStore.ensureSchema also self-heals this at boot (driven from
-- RUN_STATUSES) so existing prod DBs accept it immediately; this migration
-- keeps `npm run migrate` / fresh DBs in sync, exactly as 0097 did for
-- 'completed_noop'.
ALTER TABLE agent_control_runs DROP CONSTRAINT IF EXISTS agent_control_runs_status_check;
ALTER TABLE agent_control_runs ADD CONSTRAINT agent_control_runs_status_check CHECK (status IN (
  'queued','running','pausing','paused','stopping','stopped',
  'completed','completed_noop','failed','blocked','cancelled','partial_stop','stop_failed'
));
