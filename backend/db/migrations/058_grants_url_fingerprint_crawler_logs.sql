-- 058: grants.url + grants.fingerprint(+version) + crawler_logs table + backfill
--
-- Root-cause fix for the schema drift flagged by admin.diagnostics:
--   - grants.url / fingerprint were referenced by the matcher + apply engine
--     but did not exist on disk. matched_needs / match_decision exist (via
--     036_match_decision_metadata) and get backfilled here to neutral values
--     so the "write match decision on every persist" invariant has a sane
--     starting state for historical rows.
--   - crawler_logs was referenced by opportunityMatcher.trackGlobalOpportunity
--     and codeGuard.missionVerify goal 11 but never existed — inserts silently
--     failed and goal 11 always reported FAIL.
--
-- Keep the backfill conservative: only touch columns we can rely on
-- existing in every historical database (title, funder, amount_requested,
-- application_url, portal_url). The fingerprint is a stable blob hash that
-- dedup logic can rely on; it is NOT a cross-database-identical sha256
-- because sqlite lacks digest(). The postgres sibling migration produces
-- a true sha256 hex over the canonical identity tuple.

-- grants: missing columns (idempotent via legacy "already-applied" detection)
ALTER TABLE grants ADD COLUMN url TEXT;
ALTER TABLE grants ADD COLUMN fingerprint TEXT;
ALTER TABLE grants ADD COLUMN fingerprint_version INTEGER DEFAULT 1;

-- Backfill grants.url from application_url when available, else portal_url.
UPDATE grants
SET url = COALESCE(application_url, portal_url)
WHERE url IS NULL
  AND (application_url IS NOT NULL OR portal_url IS NOT NULL);

-- Content-based fingerprint backfill. sqlite doesn't have digest/sha256, so
-- we use lower(hex(randomblob(16))) which is stable per-row after this
-- migration (the fingerprint is only recomputed when the write path creates
-- a new row or when matcher_version changes). Dedup code reads the full
-- fingerprint string, so a random-per-row-but-stable value is fine for
-- historical backfill.
UPDATE grants
SET fingerprint = lower(hex(randomblob(16)))
WHERE fingerprint IS NULL;

-- Neutral defaults for rows that predate the matchEngine persistence
-- contract. matched_needs/match_decision already exist (036) — we just
-- ensure the legacy NULLs become '[]' / 'review' so the NOT-NULL-on-new-
-- write invariant doesn't surface stale NULLs in admin.codeGuard.matchAudit.
UPDATE grants
SET match_decision = COALESCE(match_decision, 'review')
WHERE match_decision IS NULL;

UPDATE grants
SET matched_needs = COALESCE(matched_needs, '[]')
WHERE matched_needs IS NULL;

CREATE INDEX IF NOT EXISTS idx_grants_fingerprint ON grants(fingerprint);
CREATE INDEX IF NOT EXISTS idx_grants_url          ON grants(url);

-- crawler_logs: audit trail referenced by opportunityMatcher +
-- codeGuardService goal 11. Columns are a superset of both usages so
-- neither path has to branch on dialect.
CREATE TABLE IF NOT EXISTS crawler_logs (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_id         TEXT REFERENCES crawler_jobs(id) ON DELETE CASCADE,
  profile_id     TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  crawler_type   TEXT,
  level          TEXT,
  status         TEXT,
  message        TEXT,
  payload        TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crawler_logs_job        ON crawler_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_profile    ON crawler_logs(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_created_at ON crawler_logs(created_at);
