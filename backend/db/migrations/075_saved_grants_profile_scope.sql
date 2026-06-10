-- 075_saved_grants_profile_scope.sql (SQLite)
-- @sqlite-continue-on-idempotent-errors
--
-- RC-14: profile-scope saved_grants. Adds nullable profile_id and rebuilds the
-- UNIQUE so the same opportunity can be saved independently under each profile
-- a user owns. Legacy rows (created before this migration) keep profile_id=NULL
-- and are read-visible to ALL of that user's profiles, preserving prior data.
--
-- SQLite cannot drop an inline UNIQUE constraint via ALTER, so we rebuild the
-- table. The migration runner wraps this file in a transaction; partial-apply
-- crashes ROLLBACK and the migration is retried cleanly.
--
-- Idempotency: if the migration has somehow been applied in a prior run but
-- not recorded in `_migrations` (older bootstrap path), the @sqlite-
-- continue-on-idempotent-errors directive lets the runner swallow
-- "already exists" / "duplicate column name" / "no such table" errors so the
-- recovery path doesn't false-fail.

CREATE TABLE IF NOT EXISTS saved_grants_v2 (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL,
  saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT DEFAULT NULL
);

INSERT OR IGNORE INTO saved_grants_v2 (id, user_id, profile_id, opportunity_id, saved_at, notes)
SELECT id, user_id, NULL, opportunity_id, saved_at, notes FROM saved_grants;

DROP TABLE saved_grants;

ALTER TABLE saved_grants_v2 RENAME TO saved_grants;

-- Per-profile uniqueness for new saves; partial so legacy NULL rows aren't
-- forced into a bogus single bucket.
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_profile_opp
  ON saved_grants(user_id, profile_id, opportunity_id)
  WHERE profile_id IS NOT NULL;

-- Legacy uniqueness: at most one NULL-profile row per (user, opportunity).
-- This preserves the pre-migration invariant for rows that already existed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_legacy_opp
  ON saved_grants(user_id, opportunity_id)
  WHERE profile_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_saved_grants_user_id ON saved_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_grants_opportunity_id ON saved_grants(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_saved_grants_profile_id ON saved_grants(profile_id);
