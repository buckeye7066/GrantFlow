-- One login may own MULTIPLE profiles (owner directive 2026-07-31: "combine
-- account types"). Twin of sqlite migration 160 — see its header for the full
-- rationale. ux_profiles_user_id guaranteed at most one owned profile per
-- user, so no (user_id, lower(display_name)) duplicates can exist at the time
-- this runs; the new index therefore cannot fail on live data.
BEGIN;

DROP INDEX IF EXISTS ux_profiles_user_id;

CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_user_display
  ON profiles(user_id, LOWER(display_name))
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_user_id
  ON profiles(user_id)
  WHERE user_id IS NOT NULL;

COMMIT;
