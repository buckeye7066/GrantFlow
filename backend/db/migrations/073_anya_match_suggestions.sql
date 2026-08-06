-- 073_anya_match_suggestions.sql
--
-- "Anya Match Scout" — recommend-only background discovery surface.
--
-- The Match Scout periodically scans for funding opportunities with a
-- match_score >= ANYA_MATCH_SCOUT_THRESHOLD (canonical strong bar) for each active
-- profile. When it finds one that is NOT already in the profile's pipeline
-- and has NOT been dismissed, it writes a row here AND a notification.
--
-- This table is the durable record of what was suggested, why, and what
-- the user did. It exists separately from `grants` and from
-- `pipeline_dismissals` so:
--   - we can suppress repeat popups for the same opportunity,
--   - we can learn from dismissals over time,
--   - the recommend-only stream stays distinct from "items in the pipeline."
--
-- Status lifecycle:
--   pending             — created by the scout, awaiting user action
--   accepted            — user clicked "Add to Pipeline"; action_result holds the grant id
--   dismissed           — user clicked "Not right now"
--   already_in_pipeline — scout discovered the user already added it manually
--   expired             — opportunity deadline passed before user acted

CREATE TABLE IF NOT EXISTS anya_match_suggestions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  opportunity_id TEXT,
  title TEXT NOT NULL,
  funder TEXT,
  match_score REAL NOT NULL,
  match_reasons TEXT,       -- JSON: string[] of human-readable reasons
  need_summary TEXT,        -- JSON: profileNeedsInterpreter primaryNeed keys this opp matched
  search_strategy TEXT,     -- JSON: { route, filters, search_terms } the scout used
  opportunity_data TEXT,    -- JSON: full opportunity payload (so /accept can call from-opportunity)
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  acted_at TIMESTAMP,
  action_result TEXT,       -- grant_id on accept, dismissal_reason on dismiss

  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
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

-- One *active* (pending) suggestion per (profile, opportunity). Past
-- accepted/dismissed rows still exist so the learning loop can read them.
-- Note: SQLite allows NULL columns in a unique index without conflict,
-- so opportunity_id NULL rows (synthetic suggestions) won't collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_anya_match_suggestions_active_pair
  ON anya_match_suggestions(profile_id, opportunity_id)
  WHERE status = 'pending';
