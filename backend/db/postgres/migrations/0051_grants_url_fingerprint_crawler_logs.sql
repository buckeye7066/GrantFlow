-- 0051: grants.url + grants.fingerprint(+version) + crawler_logs + backfill
--
-- Mirrors backend/db/migrations/058_grants_url_fingerprint_crawler_logs.sql
-- for Postgres. All DDL uses IF NOT EXISTS to stay safe under repeated
-- applies; the migration runner is strict for Postgres (no idempotency
-- fallback), so drift here is a hard fail.
--
-- Root cause: admin.diagnostics repeatedly reported schema drift
-- (grants.url, grants.fingerprint, crawler_logs missing), causing silent
-- write errors on match persistence and tripping codeGuard goal 11.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE grants ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS matched_needs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS match_decision TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS fingerprint_version INT DEFAULT 1;

-- Backfill url from application_url/portal_url. grants.source_url does not
-- exist on the canonical schema; the matcher writes its own source-url
-- fallback into application_url. We only fill NULL rows so this is
-- idempotent across retries.
UPDATE grants
SET url = COALESCE(application_url, portal_url)
WHERE url IS NULL
  AND (application_url IS NOT NULL OR portal_url IS NOT NULL);

-- Content-based fingerprint backfill: sha256 over title|funder|deadline.
-- We intentionally avoid columns that may be NULL everywhere (source_url,
-- description) so the hash stays stable across dialects. New rows produced
-- by backend/services/matchEngine.js use the same canonical tuple via
-- backend/utils/fingerprint.js so they match this backfill format.
UPDATE grants
SET fingerprint = encode(
  digest(
    coalesce(title, '') || '|' ||
    coalesce(funder, '') || '|' ||
    coalesce(deadline::text, ''),
    'sha256'
  ),
  'hex'
)
WHERE fingerprint IS NULL;

UPDATE grants
SET match_decision = COALESCE(match_decision, 'review')
WHERE match_decision IS NULL;

UPDATE grants
SET matched_needs = COALESCE(matched_needs, '[]'::jsonb)
WHERE matched_needs IS NULL;

CREATE INDEX IF NOT EXISTS idx_grants_fingerprint ON grants(fingerprint);
CREATE INDEX IF NOT EXISTS idx_grants_url          ON grants(url);

CREATE TABLE IF NOT EXISTS crawler_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID REFERENCES crawler_jobs(id) ON DELETE CASCADE,
  profile_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  crawler_type   TEXT,
  level          TEXT,
  status         TEXT,
  message        TEXT,
  payload        JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crawler_logs_job        ON crawler_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_profile    ON crawler_logs(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_created_at ON crawler_logs(created_at);
