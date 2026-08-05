-- @sqlite-continue-on-idempotent-errors
-- Crawler OS per-profile match store (SQLite). Postgres parity:
--   backend/db/postgres/migrations/0123_profile_opportunity_matches.sql
--
-- Canonical rule: funding_opportunities is the GLOBAL catalog (no per-profile
-- score); the match score for a (profile, opportunity) pair lives ONLY here.
-- The Crawler OS pipeline writes one row per scored pair via the persistence
-- adapter (backend/services/crawlerOsPersistence.js).
--
-- This table predates the Crawler OS in some databases with a narrower shape
-- (id PK; match_score/match_decision/match_confidence/matched_profile_facts/
-- matcher_version/evaluated_at). We bring it up to the OS shape additively:
-- create it for fresh DBs, ALTER-add the OS columns for existing DBs, and add a
-- UNIQUE (profile_id, opportunity_id) index so the adapter can upsert by pair.

CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  match_score REAL,
  match_confidence REAL,
  match_decision TEXT,
  match_explanation TEXT,
  match_reasons TEXT,
  match_explain_json TEXT,
  matcher_version TEXT,
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  evaluated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE profile_opportunity_matches ADD COLUMN match_explanation TEXT;
ALTER TABLE profile_opportunity_matches ADD COLUMN match_reasons TEXT;
ALTER TABLE profile_opportunity_matches ADD COLUMN match_explain_json TEXT;
ALTER TABLE profile_opportunity_matches ADD COLUMN match_confidence REAL;
ALTER TABLE profile_opportunity_matches ADD COLUMN computed_at DATETIME;
ALTER TABLE profile_opportunity_matches ADD COLUMN updated_at DATETIME;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pom_profile_opp
  ON profile_opportunity_matches(profile_id, opportunity_id);
CREATE INDEX IF NOT EXISTS idx_pom_profile ON profile_opportunity_matches(profile_id);
CREATE INDEX IF NOT EXISTS idx_pom_profile_score ON profile_opportunity_matches(profile_id, match_score);
