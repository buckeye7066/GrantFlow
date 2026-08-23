-- Migration 0185: the autopilot run ledger may hold every status the
-- orchestrator writes (Postgres).
--
-- MEASURED IN PROD 2026-08-22: `hamilton_autopilot_runs.status` carried the
-- CHECK from 0090 (eight statuses). The orchestrator has since written
-- `submit_attempt_started` at the irreversible click boundary,
-- `submit_evidence_pending` after it, `submission_verification_required` when
-- the receipt cannot be persisted, and `deferred` for scheduled retries. Every
-- one of those writes was rejected by the constraint, so under full automation
-- Hamilton reached the submit boundary and fail-closed into
-- `submission_verification_required` on every single live submit (4 real tasks
-- that night: "could not persist the run receipt"). No test could see it: the
-- SQLite schema the tests use has no CHECK on this column.
--
-- The allowed set is AUTOPILOT_RUN_STATUSES in
-- backend/services/hamilton/hamiltonAuthorizationStore.js; a lockstep test
-- fails when this file, schema.sql and that constant drift.
--
-- Idempotent: DROP ... IF EXISTS then ADD, both guarded.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hamilton_autopilot_runs') THEN
    ALTER TABLE hamilton_autopilot_runs DROP CONSTRAINT IF EXISTS hamilton_autopilot_runs_status_check;
    ALTER TABLE hamilton_autopilot_runs
      ADD CONSTRAINT hamilton_autopilot_runs_status_check
      CHECK (status IN (
        'queued','preflight','running','blocked','completed','submitted','failed','cancelled',
        'deferred','submit_attempt_started','submit_evidence_pending','submission_verification_required'
      ));
  END IF;
END $$;
