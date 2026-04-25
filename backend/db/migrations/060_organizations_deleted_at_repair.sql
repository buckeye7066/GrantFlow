-- @sqlite-continue-on-idempotent-errors
-- 060: Repair historical SQLite migrations that parsed ADD COLUMN IF NOT EXISTS
-- as already-applied before actually adding organizations.deleted_at.

ALTER TABLE organizations ADD COLUMN deleted_at DATETIME;
