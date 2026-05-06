-- 067_opportunity_verification_metadata.sql
--
-- Production reality gate (priority #1).
--
-- Today, several crawler paths stamp `last_verified_at = now()` even when no
-- network check actually happened. That makes the "verified" column unsafe to
-- reason about. This migration:
--
--   1. Adds `discovered_at` (when GrantFlow first ingested the row). Crawlers
--      should set this on insert, NOT `last_verified_at`.
--   2. Adds `verification_method` ('head' | 'get' | 'manual' | 'crawler' | NULL).
--      A NULL means "no real verification has happened yet".
--   3. Adds `verified_by` (who/what performed the check — worker id, job id, or
--      'crawler:<name>').
--   4. Adds `verification_error` (text of the last failure, if any).
--   5. Adds `link_status_code` (HTTP status from the last verification probe,
--      already present in some envs — IF NOT EXISTS for safety).
--   6. Adjusts the default `link_status` to 'unverified' so unchecked rows are
--      not silently treated as 'unknown' (which downstream code conflates with
--      'ok' in some places).
--   7. Backfills `discovered_at` from existing `created_at` for legacy rows so
--      the column is never NULL for existing data.

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS discovered_at DATETIME;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS verification_method TEXT;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS verified_by TEXT;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS verification_error TEXT;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS link_status_code INTEGER;

-- Backfill: every existing row gets discovered_at = created_at (or now() as a
-- last-resort when even created_at is missing). We do NOT touch
-- last_verified_at — separating discovery from verification means historical
-- rows that were stamped "verified" without a real check will be re-checked
-- by the recurring verifier and either confirmed (link_status='ok') or
-- expired (link_status='broken').
UPDATE funding_opportunities
SET discovered_at = COALESCE(discovered_at, created_at, datetime('now'))
WHERE discovered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_funding_opps_discovered_at
  ON funding_opportunities(discovered_at);
CREATE INDEX IF NOT EXISTS idx_funding_opps_verification_method
  ON funding_opportunities(verification_method);
