-- Soft-delete column referenced by routes/organizations.js (list, grants, documents, DELETE).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at ON organizations(deleted_at);
