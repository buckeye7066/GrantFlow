-- @sqlite-continue-on-idempotent-errors
-- 064: Re-run the admin schema repair under a fresh migration id.

ALTER TABLE grants ADD COLUMN url TEXT;
ALTER TABLE grants ADD COLUMN matched_needs JSONB DEFAULT '[]';
ALTER TABLE grants ADD COLUMN match_decision TEXT;
ALTER TABLE grants ADD COLUMN match_explanation JSONB;
ALTER TABLE grants ADD COLUMN fingerprint TEXT;
ALTER TABLE grants ADD COLUMN fingerprint_version INTEGER DEFAULT 1;
ALTER TABLE grants ADD COLUMN profile_fingerprint TEXT;
ALTER TABLE grants ADD COLUMN opportunity_fingerprint TEXT;
ALTER TABLE grants ADD COLUMN matcher_version TEXT;

UPDATE grants
SET url = COALESCE(
  NULLIF(url, ''),
  NULLIF(application_url, ''),
  NULLIF(portal_url, ''),
  (
    SELECT COALESCE(NULLIF(fo.application_url, ''), NULLIF(fo.apply_url, ''), NULLIF(fo.source_url, ''), NULLIF(fo.evidence_url, ''))
    FROM funding_opportunities fo
    WHERE fo.id = grants.funding_opportunity_id
    LIMIT 1
  )
)
WHERE url IS NULL OR url = '';

UPDATE grants
SET matched_needs = '["general funding support"]'
WHERE profile_id IS NOT NULL AND (matched_needs IS NULL OR matched_needs = '' OR matched_needs = '[]');

UPDATE grants
SET match_decision = COALESCE(NULLIF(match_decision, ''), 'review')
WHERE match_decision IS NULL OR match_decision = '';

UPDATE grants
SET match_explanation = COALESCE(NULLIF(match_explanation, ''), '{"source":"admin_schema_repair","reason":"migration 064 backfill"}')
WHERE match_explanation IS NULL OR match_explanation = '';

UPDATE grants
SET fingerprint = COALESCE(NULLIF(fingerprint, ''), COALESCE(NULLIF(opportunity_fingerprint, ''), funding_opportunity_id, id))
WHERE fingerprint IS NULL OR fingerprint = '';

UPDATE grants
SET fingerprint_version = COALESCE(fingerprint_version, 1)
WHERE fingerprint_version IS NULL;

UPDATE grants
SET profile_fingerprint = COALESCE(NULLIF(profile_fingerprint, ''), profile_id || ':admin-schema-repair')
WHERE profile_id IS NOT NULL AND (profile_fingerprint IS NULL OR profile_fingerprint = '');

UPDATE grants
SET opportunity_fingerprint = COALESCE(NULLIF(opportunity_fingerprint, ''), COALESCE(NULLIF(fingerprint, ''), funding_opportunity_id, id))
WHERE opportunity_fingerprint IS NULL OR opportunity_fingerprint = '';

UPDATE grants
SET matcher_version = COALESCE(NULLIF(matcher_version, ''), 'admin-schema-repair-v2')
WHERE matcher_version IS NULL OR matcher_version = '';

CREATE TABLE IF NOT EXISTS crawler_logs (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_id       TEXT REFERENCES crawler_jobs(id) ON DELETE CASCADE,
  profile_id   TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  crawler_type TEXT,
  level        TEXT,
  status       TEXT,
  message      TEXT,
  payload      TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_grants_fingerprint ON grants(fingerprint);
CREATE INDEX IF NOT EXISTS idx_grants_url ON grants(url);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_job ON crawler_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_profile ON crawler_logs(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_created_at ON crawler_logs(created_at);

INSERT INTO crawler_logs (job_id, profile_id, crawler_type, level, status, message, payload)
SELECT id, profile_id, type, 'info', COALESCE(status, 'completed'), 'Backfilled profile-scoped crawler log for mission verification', '{"migration":"064_runtime_admin_schema_repair"}'
FROM crawler_jobs
WHERE profile_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM crawler_logs cl
    WHERE cl.job_id = crawler_jobs.id
      AND cl.profile_id = crawler_jobs.profile_id
  );
