-- Migration 030: Expand record_origin CHECK constraint (SQLite)
--
-- SQLite does not support ALTER TABLE ... DROP CONSTRAINT.
-- Pragmatic approach: remove the CHECK constraint entirely for SQLite
-- (which is only used in local dev / tests).  The Postgres migration
-- (0034) enforces the full expanded constraint in production.
--
-- SQLite 3.35+ supports DROP COLUMN but NOT drop/alter constraints.
-- The safest approach is to just disable the constraint check:

-- No-op migration for SQLite — the CHECK is enforced in Postgres.
-- To fix locally, recreate the DB: npm run db:reset
SELECT 1;
