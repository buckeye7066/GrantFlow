-- Portal ↔ GrantFlow two-way data-sync run log (Postgres). SQLite parity:
--   backend/db/migrations/120_portal_sync_runs.sql
--
-- Each row records one runPortalSync invocation (read / write / both) for a
-- profile against a portal host: which connector ran, the outcome, and a JSON
-- summary (fields/awards persisted, notFound, write written/skipped). The
-- service self-heals this schema (ensurePortalSyncSchema) so it works even
-- before this migration runs; the migration keeps prod schema in lockstep.

CREATE TABLE IF NOT EXISTS portal_sync_runs (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  profile_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,
  connector_id TEXT,
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  summary JSONB,
  error TEXT,
  actor_user_id TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_portal_sync_runs_profile ON portal_sync_runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_portal_sync_runs_host ON portal_sync_runs(portal_host);
CREATE INDEX IF NOT EXISTS idx_portal_sync_runs_status ON portal_sync_runs(status);
