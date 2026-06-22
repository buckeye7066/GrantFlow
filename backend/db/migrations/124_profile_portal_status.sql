-- @sqlite-continue-on-idempotent-errors
-- Per-profile portal MERGE/COMPLETION lifecycle (SQLite). Postgres parity:
--   backend/db/postgres/migrations/0125_profile_portal_status.sql
--
-- Records, per (profile_id, portal_host), where a funding-source portal sits in
-- its lifecycle, DISTINCT from the live green/red "ready" status that
-- profilePortalIndex derives:
--   status='unmerged'  — applies but not yet pulled into the profile (default;
--                        also the implicit state when no row exists)
--   status='complete'  — a COMPLETED application was uploaded/linked (e.g. a
--                        completed FAFSA) but NOT merged (completed != merged)
--   status='merged'    — the portal's data has been merged into the profile
--                        (terminal; excluded from the weekly Monday reminder)
--
-- The store self-heals this schema (ensurePortalCompletionSchema) so the feature
-- works even before this migration runs; ensureSchemaInvariants.js re-asserts it
-- on every boot. This migration keeps prod schema in lockstep.

CREATE TABLE IF NOT EXISTS profile_portal_status (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unmerged',
  source TEXT,
  evidence TEXT,
  grant_id TEXT,
  document_id TEXT,
  completed_at DATETIME,
  merged_at DATETIME,
  last_reminded_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_profile_portal_status_profile ON profile_portal_status(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_portal_status_status ON profile_portal_status(status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_portal_status_profile_host ON profile_portal_status(profile_id, portal_host);
