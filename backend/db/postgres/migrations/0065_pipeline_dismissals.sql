-- Pipeline dismissals (Postgres mirror of SQLite migration 071).
-- See backend/db/migrations/071_pipeline_dismissals.sql for the full
-- explanation of why this table exists and how it gates auto-add.

CREATE TABLE IF NOT EXISTS pipeline_dismissals (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  fingerprint TEXT,
  opportunity_id TEXT,
  source_url TEXT,
  title TEXT,
  reason TEXT,
  dismissed_by TEXT,
  dismissed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_dismissals_profile
  ON pipeline_dismissals(profile_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_dismissals_fingerprint
  ON pipeline_dismissals(profile_id, fingerprint);

CREATE INDEX IF NOT EXISTS idx_pipeline_dismissals_opp
  ON pipeline_dismissals(profile_id, opportunity_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_dismissals_unique_fp
  ON pipeline_dismissals(profile_id, fingerprint)
  WHERE fingerprint IS NOT NULL;
