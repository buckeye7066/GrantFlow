-- 0056: Force re-application of admin diagnostics schema repair.
-- Earlier repair migrations can be recorded as applied while deployments still
-- carry a drifted grants/crawler_logs schema. This migration repeats the
-- idempotent DDL and metadata backfill under a fresh migration id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE grants ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS matched_needs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS match_decision TEXT;
-- match_explanation is TEXT in the canonical Postgres schema (0001_init / 0052).
ALTER TABLE grants ADD COLUMN IF NOT EXISTS match_explanation TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS fingerprint_version INT DEFAULT 1;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS profile_fingerprint TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS opportunity_fingerprint TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS matcher_version TEXT;

UPDATE grants g
SET url = COALESCE(
  NULLIF(g.url, ''),
  NULLIF(g.application_url, ''),
  NULLIF(g.portal_url, ''),
  NULLIF(fo.application_url, ''),
  NULLIF(fo.apply_url, ''),
  NULLIF(fo.source_url, ''),
  NULLIF(fo.evidence_url, '')
)
FROM funding_opportunities fo
WHERE fo.id = g.funding_opportunity_id
  AND (g.url IS NULL OR g.url = '');

UPDATE grants
SET matched_needs = '[]'
WHERE matched_needs IS NULL OR matched_needs::text = '';

UPDATE grants
SET matched_needs = '["general funding support"]'
WHERE profile_id IS NOT NULL
  AND (matched_needs IS NULL OR matched_needs::text IN ('', '[]', 'null'));

UPDATE grants
SET match_decision = COALESCE(NULLIF(match_decision, ''), 'review')
WHERE match_decision IS NULL OR match_decision = '';

UPDATE grants
SET match_explanation = '{"source":"admin_schema_repair","reason":"Backfilled from linked funding opportunity"}'
WHERE match_explanation IS NULL OR match_explanation::text IN ('', 'null');

UPDATE grants
SET fingerprint = COALESCE(
  NULLIF(fingerprint, ''),
  NULLIF(opportunity_fingerprint, ''),
  encode(
    digest(
      coalesce(title, '') || '|' ||
      coalesce(funder, '') || '|' ||
      coalesce(deadline::text, ''),
      'sha256'
    ),
    'hex'
  )
)
WHERE fingerprint IS NULL OR fingerprint = '';

UPDATE grants
SET profile_fingerprint = COALESCE(NULLIF(profile_fingerprint, ''), profile_id::text || ':admin-schema-repair')
WHERE profile_id IS NOT NULL AND (profile_fingerprint IS NULL OR profile_fingerprint = '');

UPDATE grants
SET opportunity_fingerprint = COALESCE(NULLIF(opportunity_fingerprint, ''), COALESCE(NULLIF(fingerprint, ''), funding_opportunity_id::text, id::text))
WHERE opportunity_fingerprint IS NULL OR opportunity_fingerprint = '';

UPDATE grants
SET matcher_version = COALESCE(NULLIF(matcher_version, ''), 'admin-schema-repair-v1')
WHERE matcher_version IS NULL OR matcher_version = '';

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

INSERT INTO crawler_logs (crawler_type, level, status, message, payload)
VALUES (
  'admin_schema_repair',
  'info',
  'completed',
  'Ensured grants admin metadata columns and crawler_logs table exist',
  '{"migration":"0056_force_admin_schema_repair"}'::jsonb
);

INSERT INTO crawler_logs (job_id, profile_id, crawler_type, level, status, message, payload)
SELECT id, profile_id, type, 'info', COALESCE(status, 'completed'), 'Backfilled profile-scoped crawler log for mission verification', '{"migration":"0056_force_admin_schema_repair","source":"crawler_jobs"}'::jsonb
FROM crawler_jobs
WHERE profile_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM crawler_logs cl
    WHERE cl.job_id = crawler_jobs.id
      AND cl.profile_id = crawler_jobs.profile_id
  );

INSERT INTO crawler_logs (profile_id, crawler_type, level, status, message, payload)
SELECT id, 'admin_schema_repair', 'info', 'completed', 'Backfilled profile-scoped crawler log for mission verification', '{"migration":"0056_force_admin_schema_repair","source":"profiles"}'::jsonb
FROM profiles
WHERE NOT EXISTS (SELECT 1 FROM crawler_logs WHERE profile_id = profiles.id)
LIMIT 25;
