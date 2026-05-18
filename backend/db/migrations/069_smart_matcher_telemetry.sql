-- 069: Smart Matcher telemetry tables (spec §7).
-- @sqlite-continue-on-idempotent-errors
--
-- low_coverage_events: one row per Discover/SmartMatcher search where the
-- qualified set is too small (< 3 results). Lets admins iteratively fill
-- funder source gaps and surface frequent low-coverage queries on the
-- Anya Admin dashboard. Lightweight (single row/search) and non-blocking —
-- failure to write does not block the matching response.
--
-- match_feedback: per-result feedback ("Not relevant" / "Wrong category" /
-- "Helpful") that future scorer iterations can read to down-weight chronic
-- mismatches for a given query type.

CREATE TABLE IF NOT EXISTS low_coverage_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT,
  primary_category TEXT,
  search_terms TEXT,
  qualified_count INTEGER,
  returned_count INTEGER,
  candidate_count INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_low_coverage_created
  ON low_coverage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_low_coverage_profile
  ON low_coverage_events(profile_id);
CREATE INDEX IF NOT EXISTS idx_low_coverage_category
  ON low_coverage_events(primary_category);

CREATE TABLE IF NOT EXISTS match_feedback (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT,
  opportunity_id TEXT,
  primary_category TEXT,
  feedback TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_match_feedback_profile
  ON match_feedback(profile_id);
CREATE INDEX IF NOT EXISTS idx_match_feedback_opp
  ON match_feedback(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_match_feedback_created
  ON match_feedback(created_at DESC);
