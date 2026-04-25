-- 0052: Harden admin-tool schema drift repair for partial historical applies.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE grants ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS matched_needs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS match_decision TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS match_explanation TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS fingerprint_version INT DEFAULT 1;

UPDATE grants
SET url = COALESCE(url, application_url, portal_url)
WHERE url IS NULL
  AND (application_url IS NOT NULL OR portal_url IS NOT NULL);

UPDATE grants
SET matched_needs = COALESCE(matched_needs, '[]'::jsonb)
WHERE matched_needs IS NULL;

UPDATE grants
SET match_decision = COALESCE(NULLIF(match_decision, ''), 'review')
WHERE match_decision IS NULL OR match_decision = '';

UPDATE grants
SET match_explanation = 'Backfilled from existing grant row for admin schema repair'
WHERE match_explanation IS NULL OR match_explanation = '';

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
WHERE fingerprint IS NULL OR fingerprint = '';

UPDATE grants
SET fingerprint_version = COALESCE(fingerprint_version, 1)
WHERE fingerprint_version IS NULL;

CREATE INDEX IF NOT EXISTS idx_grants_fingerprint ON grants(fingerprint);
CREATE INDEX IF NOT EXISTS idx_grants_url ON grants(url);

CREATE TABLE IF NOT EXISTS crawler_logs (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_id       TEXT REFERENCES crawler_jobs(id) ON DELETE CASCADE,
  profile_id   TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  crawler_type TEXT,
  level        TEXT,
  status       TEXT,
  message      TEXT,
  payload      JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crawler_logs_job ON crawler_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_profile ON crawler_logs(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_created_at ON crawler_logs(created_at);
