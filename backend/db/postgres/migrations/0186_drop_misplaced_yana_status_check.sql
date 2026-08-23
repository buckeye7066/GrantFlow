-- 0186: drop the MISPLACED status CHECK stranded on hamilton_autopilot_runs.
--
-- Measured live 2026-08-23 during the first real e2e submit: a stale
-- constraint named yana_autopilot_runs_status_check — carrying the OLD
-- 8-status list, evidently copied onto the Hamilton table with Yana's DDL —
-- sat BESIDE the canonical hamilton_autopilot_runs_status_check that 0185
-- widened. Every submit-boundary receipt write (status =
-- 'submit_attempt_started') still violated the stale twin, the fail-closed
-- guard quarantined the task, and the failure was invisible because the
-- lockstep test only knew about the canonical constraint's name.
--
-- Yana's OWN table (if present) keeps its own constraint; this touches only
-- the one stranded on the Hamilton table. Idempotent — prod was hand-repaired
-- 2026-08-23 06:1xZ and this records/reproduces that repair everywhere else.
ALTER TABLE hamilton_autopilot_runs
  DROP CONSTRAINT IF EXISTS yana_autopilot_runs_status_check;
