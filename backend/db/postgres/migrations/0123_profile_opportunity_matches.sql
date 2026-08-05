-- Crawler OS per-profile match store (Postgres). SQLite parity:
--   backend/db/migrations/122_profile_opportunity_matches.sql
--
-- Canonical rule: funding_opportunities is the GLOBAL catalog (no per-profile
-- score); the match score for a (profile, opportunity) pair lives ONLY here.
-- This table predates the Crawler OS in some databases with a narrower shape;
-- bring it up to the OS shape additively and add a UNIQUE (profile_id,
-- opportunity_id) index so the persistence adapter can upsert by pair.

CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  profile_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  match_score REAL,
  match_confidence DOUBLE PRECISION,
  match_decision TEXT,
  match_explanation TEXT,
  match_reasons TEXT,
  match_explain_json TEXT,
  matcher_version TEXT,
  computed_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  evaluated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE profile_opportunity_matches ADD COLUMN IF NOT EXISTS match_explanation TEXT;
ALTER TABLE profile_opportunity_matches ADD COLUMN IF NOT EXISTS match_reasons TEXT;
ALTER TABLE profile_opportunity_matches ADD COLUMN IF NOT EXISTS match_explain_json TEXT;
ALTER TABLE profile_opportunity_matches ADD COLUMN IF NOT EXISTS match_confidence DOUBLE PRECISION;
ALTER TABLE profile_opportunity_matches ADD COLUMN IF NOT EXISTS computed_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE profile_opportunity_matches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_pom_profile_opp
  ON profile_opportunity_matches(profile_id, opportunity_id);
CREATE INDEX IF NOT EXISTS idx_pom_profile ON profile_opportunity_matches(profile_id);
CREATE INDEX IF NOT EXISTS idx_pom_profile_score ON profile_opportunity_matches(profile_id, match_score);
