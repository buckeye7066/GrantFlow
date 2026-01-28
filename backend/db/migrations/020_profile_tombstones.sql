-- Tombstones for hard-deleted profiles.
-- Prevents startup seeding/ensure logic from resurrecting removed profiles.

CREATE TABLE IF NOT EXISTS profile_tombstones (
  profile_id TEXT PRIMARY KEY,
  deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_by TEXT,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_tombstones_deleted_at ON profile_tombstones(deleted_at);

