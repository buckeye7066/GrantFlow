-- Migration 0038: Add performance indexes for common query patterns
-- Uses IF NOT EXISTS for idempotent re-runs.

-- Funding opportunities (additional indexes beyond 028 / 0037)
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_created ON funding_opportunities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_active_created ON funding_opportunities(is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_source ON funding_opportunities(record_origin);

-- Profiles
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_display_name ON profiles(display_name);
CREATE INDEX IF NOT EXISTS idx_profiles_created ON profiles(created_at);

-- Grants
CREATE INDEX IF NOT EXISTS idx_grants_profile_id ON grants(profile_id);
CREATE INDEX IF NOT EXISTS idx_grants_status ON grants(status);

-- Documents
CREATE INDEX IF NOT EXISTS idx_documents_profile_id ON documents(profile_id);

-- Organizations
CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations(name);
