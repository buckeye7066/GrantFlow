-- One login may own MULTIPLE profiles (owner directive 2026-07-31: "combine
-- account types" — a person applies as an individual AND runs a farm, a
-- business, a nonprofit, or has students in school, all under one account).
--
-- ux_profiles_user_id (migration 045) enforced ONE owned profile per user. It
-- existed to stop accidental duplicate signup shells, not as a product rule
-- that a person has only one applicant identity — and it silently corrupted
-- the multi-profile flow: the Create Profile UI (Organizations quickAdd) POSTs
-- a second profile, and the route's adopt path OVERWROTE the user's existing
-- profile's name/type with the new one's instead of creating it.
--
-- The duplicate protection is retained STRUCTURALLY, one level down: a user
-- may not own two profiles with the same (case-insensitive) display name, so
-- a re-submitted create still converges on the same row while "Anita's Farm"
-- can exist alongside "Anita Mayes".
DROP INDEX IF EXISTS ux_profiles_user_id;

CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_user_display
  ON profiles(user_id, LOWER(display_name))
  WHERE user_id IS NOT NULL;

-- Keep owned-profile lookups indexed now that the unique index is gone.
CREATE INDEX IF NOT EXISTS idx_profiles_user_id
  ON profiles(user_id)
  WHERE user_id IS NOT NULL;
