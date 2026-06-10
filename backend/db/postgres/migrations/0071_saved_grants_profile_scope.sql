-- 0071_saved_grants_profile_scope.sql (Postgres)
--
-- RC-14: profile-scope saved_grants. Mirrors SQLite migration 075. Postgres
-- supports DROP CONSTRAINT and ALTER ADD COLUMN IF NOT EXISTS, so we don't
-- need a table rebuild here.

-- Add the new nullable profile_id column.
ALTER TABLE saved_grants
  ADD COLUMN IF NOT EXISTS profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE;

-- Drop the original UNIQUE(user_id, opportunity_id). Constraint name matches
-- Postgres' auto-generation rule for inline UNIQUE on those columns.
ALTER TABLE saved_grants
  DROP CONSTRAINT IF EXISTS saved_grants_user_id_opportunity_id_key;

-- Belt-and-suspenders: drop the same indexes if a prior partial-apply created
-- them, before we (re)create them with the partial-where clauses.
DROP INDEX IF EXISTS uq_saved_grants_user_profile_opp;
DROP INDEX IF EXISTS uq_saved_grants_user_legacy_opp;

-- Per-profile uniqueness for new saves; partial so legacy NULL rows aren't
-- forced into a bogus single bucket.
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_profile_opp
  ON saved_grants(user_id, profile_id, opportunity_id)
  WHERE profile_id IS NOT NULL;

-- Legacy uniqueness: at most one NULL-profile row per (user, opportunity).
-- Preserves the pre-migration invariant for rows already in the table.
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_legacy_opp
  ON saved_grants(user_id, opportunity_id)
  WHERE profile_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_saved_grants_profile_id ON saved_grants(profile_id);
