-- Phase 5: Per-profile grant pipeline persistence + idempotency
-- Add profile_id to grants so pipeline entries can be scoped to the active profile,
-- preventing cross-profile leakage when multiple profiles share an organization.

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_grants_profile_id ON grants(profile_id);

-- Idempotency: a profile should never receive the same opportunity twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_profile_opportunity
  ON grants(profile_id, funding_opportunity_id)
  WHERE profile_id IS NOT NULL AND funding_opportunity_id IS NOT NULL;

