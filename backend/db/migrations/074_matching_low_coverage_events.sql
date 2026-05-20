-- Telemetry for Smart Matcher low-coverage events (qualified < 3).
CREATE TABLE IF NOT EXISTS matching_low_coverage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT,
  search_terms TEXT,
  free_text TEXT,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  min_score INTEGER NOT NULL DEFAULT 50,
  intent_label TEXT,
  branded_program TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_matching_low_coverage_recorded
  ON matching_low_coverage_events(recorded_at DESC);
