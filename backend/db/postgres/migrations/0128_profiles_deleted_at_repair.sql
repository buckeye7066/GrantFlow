-- 0128: Repair historical Postgres databases that predate profiles.deleted_at.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_profiles_deleted_at ON profiles(deleted_at);
