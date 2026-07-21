-- Durable decisions for qualified-pipeline promotion. SQLite parity:
-- backend/db/migrations/150_pipeline_promotion_outcomes.sql

CREATE TABLE IF NOT EXISTS pipeline_promotion_outcomes (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'dry_run')),
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  score REAL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 1,
  profile_facts_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  opportunity_updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, opportunity_id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_promotion_outcomes_mode_outcome
  ON pipeline_promotion_outcomes(mode, outcome);
CREATE INDEX IF NOT EXISTS idx_pipeline_promotion_outcomes_attempted
  ON pipeline_promotion_outcomes(attempted_at);
