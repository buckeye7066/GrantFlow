-- Migration 0068: anya_match_suggestions table (Postgres)
--
-- "Anya Match Scout" — recommend-only background discovery surface.
-- See backend/services/anyaMatchScout.js for the writer and
-- backend/routes/anyaMatchSuggestions.js for the user-facing API.
--
-- Status lifecycle:
--   pending             — created by the scout, awaiting user action
--   accepted            — user clicked "Add to Pipeline"; action_result = grant_id
--   dismissed           — user clicked "Not right now"
--   already_in_pipeline — discovered the user added it manually
--   expired             — opportunity deadline passed before user acted

CREATE TABLE IF NOT EXISTS anya_match_suggestions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id TEXT,
  opportunity_id TEXT,
  title TEXT NOT NULL,
  funder TEXT,
  match_score REAL NOT NULL,
  match_reasons JSONB,
  need_summary JSONB,
  search_strategy JSONB,
  opportunity_data JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'dismissed', 'already_in_pipeline', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acted_at TIMESTAMPTZ,
  action_result TEXT
);

CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_profile
  ON anya_match_suggestions(profile_id);
CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_user
  ON anya_match_suggestions(user_id);
CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_status
  ON anya_match_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_opportunity
  ON anya_match_suggestions(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_created
  ON anya_match_suggestions(created_at);

-- Partial unique index: one *pending* suggestion per (profile, opportunity).
-- Past accepted/dismissed rows are retained for the learning loop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_anya_match_suggestions_active_pair
  ON anya_match_suggestions(profile_id, opportunity_id)
  WHERE status = 'pending';
