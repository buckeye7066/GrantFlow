CREATE TABLE IF NOT EXISTS profile_section_audit (
  id BIGSERIAL PRIMARY KEY,
  profile_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  key TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  reason TEXT NOT NULL,
  repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profile_section_audit_profile
  ON profile_section_audit (profile_id, section_key, repaired_at DESC);
