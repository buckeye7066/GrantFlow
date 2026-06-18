-- Yana web-crawler enrichment: a public contact person for an organization.
-- See backend/db/migrations/094_org_contact_person.sql for rationale.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_title TEXT;
