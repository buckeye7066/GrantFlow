-- Postgres migration 0006: Core access-pattern indexes (stability/perf)
-- Safe: all indexes use IF NOT EXISTS.

-- Profiles: common lookups
CREATE INDEX IF NOT EXISTS idx_profiles_user_id
  ON profiles(user_id);

CREATE INDEX IF NOT EXISTS idx_profiles_org_id
  ON profiles(organization_id);

CREATE INDEX IF NOT EXISTS idx_profiles_created_at
  ON profiles(created_at DESC);

-- Grants: pipeline views and org dashboards
CREATE INDEX IF NOT EXISTS idx_grants_organization_status
  ON grants(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_grants_deadline
  ON grants(deadline);

-- Milestones: dashboard reminders and calendar views
CREATE INDEX IF NOT EXISTS idx_milestones_org_due_date
  ON milestones(organization_id, due_date);

CREATE INDEX IF NOT EXISTS idx_milestones_grant_due_date
  ON milestones(grant_id, due_date);

-- Documents: profile document panels
CREATE INDEX IF NOT EXISTS idx_profile_documents_profile_id
  ON profile_documents(profile_id);

