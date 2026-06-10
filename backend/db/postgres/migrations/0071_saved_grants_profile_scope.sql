-- 0071_saved_grants_profile_scope.sql  (RC-14)
-- Profile-scope saved grants (Postgres). Mirrors SQLite migration 075.
--
-- Postgres can alter the constraint in place, so no table rebuild is needed:
--   1. add `profile_id` (NOT NULL DEFAULT '' — '' means "no/legacy profile")
--   2. drop the old UNIQUE(user_id, opportunity_id) constraint
--   3. add a UNIQUE index on (user_id, profile_id, opportunity_id)
-- A unique index (not a named constraint) is used for the new key so it is
-- idempotent via CREATE UNIQUE INDEX IF NOT EXISTS — matching the runtime
-- self-heal in services/savedGrantsSchema.js. ON CONFLICT works against a
-- unique index just as it does a constraint.

ALTER TABLE saved_grants ADD COLUMN IF NOT EXISTS profile_id TEXT;
UPDATE saved_grants SET profile_id = '' WHERE profile_id IS NULL;
ALTER TABLE saved_grants ALTER COLUMN profile_id SET DEFAULT '';
ALTER TABLE saved_grants ALTER COLUMN profile_id SET NOT NULL;

-- Drop the auto-named old unique constraint (CREATE TABLE inline UNIQUE).
ALTER TABLE saved_grants DROP CONSTRAINT IF EXISTS saved_grants_user_id_opportunity_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS saved_grants_user_profile_opp_uidx
  ON saved_grants(user_id, profile_id, opportunity_id);
CREATE INDEX IF NOT EXISTS idx_saved_grants_profile_id ON saved_grants(profile_id);
