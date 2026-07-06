-- Migration 0134: guided_cycle_tour_status (Postgres twin of SQLite 130)
--
-- See backend/db/migrations/130_add_guided_cycle_tour_status.sql for the
-- full rationale. NULL = not eligible; 'pending'/'completed'/'skipped'
-- otherwise, set exactly once at intake-completion time.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'guided_cycle_tour_status'
  ) THEN
    ALTER TABLE users ADD COLUMN guided_cycle_tour_status TEXT DEFAULT NULL;
  END IF;
END $$;
