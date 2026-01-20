-- Add profile_id to grants for traceability of match_score
ALTER TABLE grants ADD COLUMN IF NOT EXISTS profile_id TEXT;
CREATE INDEX IF NOT EXISTS idx_grants_profile_id ON grants(profile_id);
