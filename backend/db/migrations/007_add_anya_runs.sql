-- SQLite migration 007: Compatibility patch for anya_runs
--
-- Background:
-- Earlier migrations (006_*) create an `anya_runs` table used by the runtime code.
-- This 007 migration previously attempted to create a *different* anya_runs schema
-- and then created an index on `run_id`, which fails when the table already exists.
--
-- Goal:
-- Keep migrations idempotent and ensure this file never breaks fresh installs.
--
-- NOTE:
-- SQLite does not support conditional DDL in plain SQL. This migration assumes
-- `anya_runs` already exists (created by 006_*). If you have an older database
-- where `anya_runs` doesn't exist, run the earlier migrations first.

-- Add correlation column used by some operational tooling (nullable for compatibility).
-- NOTE: SQLite doesn't support ADD COLUMN IF NOT EXISTS in all builds; the migration runner
-- treats "duplicate column name" as idempotent and will record this migration as applied.
ALTER TABLE anya_runs ADD COLUMN run_id TEXT;

-- Index for querying runs by run_id (for correlation).
CREATE INDEX IF NOT EXISTS idx_anya_runs_run_id ON anya_runs(run_id);
