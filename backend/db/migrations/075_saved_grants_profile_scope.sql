-- 075_saved_grants_profile_scope.sql  (RC-14)
-- @sqlite-continue-on-idempotent-errors
--
-- Profile-scope saved grants so a user's saves no longer bleed across their
-- profiles, and the SAME opportunity can be saved independently under more than
-- one profile.
--
-- SQLite cannot ALTER a UNIQUE constraint, so we rebuild the table to replace
--   UNIQUE(user_id, opportunity_id)
-- with
--   UNIQUE(user_id, profile_id, opportunity_id).
--
-- Ordering safety: the runtime self-heal (services/savedGrantsSchema.js) may
-- have already upgraded this table and stored real profile_ids BEFORE this
-- migration runs. So we must PRESERVE existing profile_id values, never clobber
-- them. We do that by first ensuring the column exists (the ALTER is skipped via
-- the idempotent-error path when it already does), then copying profile_id
-- through verbatim during the rebuild. On a genuinely old table the freshly
-- added column defaults to '' (the "no/legacy profile" sentinel).

-- Step 1: guarantee the column exists. On an already-migrated table this raises
-- "duplicate column name" which the runner treats as already-applied and skips.
ALTER TABLE saved_grants ADD COLUMN profile_id TEXT NOT NULL DEFAULT '';

-- Step 2: rebuild to swap the UNIQUE constraint, preserving every column.
CREATE TABLE saved_grants_rc14 (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL DEFAULT '',
  opportunity_id TEXT NOT NULL,
  saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT DEFAULT NULL,
  UNIQUE(user_id, profile_id, opportunity_id)
);

INSERT OR IGNORE INTO saved_grants_rc14 (id, user_id, profile_id, opportunity_id, saved_at, notes)
  SELECT id, user_id, profile_id, opportunity_id, saved_at, notes FROM saved_grants;

DROP TABLE saved_grants;
ALTER TABLE saved_grants_rc14 RENAME TO saved_grants;

CREATE INDEX IF NOT EXISTS idx_saved_grants_user_id ON saved_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_grants_opportunity_id ON saved_grants(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_saved_grants_profile_id ON saved_grants(profile_id);
