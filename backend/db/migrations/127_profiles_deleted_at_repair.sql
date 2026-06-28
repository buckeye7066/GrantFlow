-- @sqlite-continue-on-idempotent-errors
-- 127: Repair historical SQLite databases that predate profiles.deleted_at.

ALTER TABLE profiles ADD COLUMN deleted_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_profiles_deleted_at ON profiles(deleted_at);
