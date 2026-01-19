-- Postgres migration 0009: add user_organizations join table
-- Fixes production errors: "relation \"user_organizations\" does not exist"

CREATE TABLE IF NOT EXISTS user_organizations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_user_organizations_org
  ON user_organizations(organization_id);

