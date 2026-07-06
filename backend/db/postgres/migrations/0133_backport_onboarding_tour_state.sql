-- Migration 0133: backport onboarding/tour state columns to Postgres
--
-- SQLite migration 047_add_onboarding_tour_state.sql added
-- has_completed_onboarding / onboarding_completed_at / last_seen_manual_version
-- / last_completed_tour_version / tour_dismissed_at to `users`, but no
-- Postgres-dialect twin was ever written. Confirmed missing in prod via
-- `railway connect Postgres` (0 rows for all five column names) on
-- 2026-07-05 -- the existing AnyaGuidedTour version-gate and onboarding-state
-- endpoint have been silently degrading in prod ever since (defensive
-- try/catch in backend/routes/auth.js masked the missing columns rather than
-- erroring). Backported here, each column independently guarded so a partial
-- prior application (if any) isn't clobbered. Also re-asserted at boot via
-- ensureSchemaInvariants.ensureOnboardingTourStateColumns for the same
-- self-healing guarantee as other invariant-covered columns.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'has_completed_onboarding'
  ) THEN
    ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT FALSE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'onboarding_completed_at'
  ) THEN
    ALTER TABLE users ADD COLUMN onboarding_completed_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'last_seen_manual_version'
  ) THEN
    ALTER TABLE users ADD COLUMN last_seen_manual_version INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'last_completed_tour_version'
  ) THEN
    ALTER TABLE users ADD COLUMN last_completed_tour_version INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'tour_dismissed_at'
  ) THEN
    ALTER TABLE users ADD COLUMN tour_dismissed_at TIMESTAMPTZ;
  END IF;
END $$;
