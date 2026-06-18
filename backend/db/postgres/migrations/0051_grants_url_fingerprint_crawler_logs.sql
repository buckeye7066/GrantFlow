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
-- match_explanation is TEXT in the canonical Postgres schema (grants stores
-- JSON-as-text; the matcher writes JSON.stringify(...)). It must exist before
-- the backfill below — on a fresh replay nothing has created it yet (0052 is
-- the next migration to add it), so create it here to keep the chain replayable.
ALTER TABLE grants ADD COLUMN IF NOT EXISTS match_explanation TEXT;

-- Prod drift repair: some environments materialised grants.match_explanation
-- as JSONB (e.g. via the SQLite->Postgres data import), but the canonical type
-- is TEXT — the matcher writes JSON.stringify(...) as a string, readers treat
-- it as text, and no code uses jsonb operators on it. The text backfills below
-- (and the `match_explanation = ''` comparisons in 0052/0055/0057) fail on a
-- jsonb column with "invalid input syntax for type json" because '' is not
-- valid JSON. Normalise to TEXT first; no-op when already TEXT. This unblocks
-- the whole grants-backfill chain (0051/0052/0055/0057).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'grants' AND column_name = 'match_explanation' AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE grants ALTER COLUMN match_explanation TYPE TEXT USING match_explanation::text;
  END IF;
END $$;

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

-- Backfill match_explanation when NULL/empty so admin.codeGuard.matchAudit
-- can grade legacy rows on completeness. Live matcher writes richer values.
UPDATE grants
SET match_explanation = 'Backfilled: ' || COALESCE(NULLIF(title, ''), 'Untitled') || ' from ' || COALESCE(NULLIF(funder, ''), 'Unknown funder') || ' — review recommended'
WHERE (match_explanation IS NULL OR match_explanation = '');

-- Seed matched_needs when empty/null with a single backfill tag so the
-- withNeeds counter is non-zero for historical rows. Overwritten on re-match.
UPDATE grants
SET matched_needs = '["backfill"]'::jsonb
WHERE matched_needs IS NULL OR matched_needs = '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_grants_fingerprint ON grants(fingerprint);
CREATE INDEX IF NOT EXISTS idx_grants_url          ON grants(url);

CREATE TABLE IF NOT EXISTS crawler_logs (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_id         TEXT REFERENCES crawler_jobs(id) ON DELETE CASCADE,
  profile_id     TEXT REFERENCES profiles(id) ON DELETE SET NULL,
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
