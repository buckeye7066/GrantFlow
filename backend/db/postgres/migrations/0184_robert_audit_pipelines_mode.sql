-- Migration 0184: Robert gains the `audit-pipelines` mode (Postgres).
--
-- Owner order 2026-08-21. `robert_runs.mode` carries a CHECK listing the eight
-- original modes (`0077_robert_tables.sql`), so on prod the FIRST audit run
-- would fail at `startRun` with a constraint violation — and `startRun` is the
-- very first thing `runRobert` does, so the whole mode would be dead on
-- arrival with an error that names a constraint, not a missing feature.
--
-- Idempotent: DROP ... IF EXISTS then ADD, both guarded, so re-applying is
-- safe and a database that never had the constraint simply gains it.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'robert_runs') THEN
    ALTER TABLE robert_runs DROP CONSTRAINT IF EXISTS robert_runs_mode_check;
    ALTER TABLE robert_runs
      ADD CONSTRAINT robert_runs_mode_check
      CHECK (mode IN (
        'observe','discover-sources','discover-opportunities','verify',
        'ingest','match','recommend','full-cycle','audit-pipelines'
      ));
  END IF;
END $$;
