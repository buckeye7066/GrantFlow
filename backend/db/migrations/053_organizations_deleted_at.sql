-- SQLite: align with Postgres soft-delete for organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at DATETIME;
