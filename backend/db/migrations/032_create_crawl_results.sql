-- Create crawl_results and crawl_metadata tables for the curated crawler system
CREATE TABLE IF NOT EXISTS crawl_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  program_name TEXT NOT NULL,
  program_url TEXT,
  program_description TEXT,
  match_score INTEGER DEFAULT 0,
  match_reasons TEXT,
  matched_categories TEXT,
  program_type TEXT,
  funding_type TEXT,
  max_amount TEXT,
  source_type TEXT,
  crawled_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crawl_results_profile ON crawl_results(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawl_results_score ON crawl_results(match_score DESC);

CREATE TABLE IF NOT EXISTS crawl_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL UNIQUE,
  state TEXT,
  analysis_json TEXT,
  county_contacts TEXT,
  total_matches INTEGER,
  crawled_at DATETIME DEFAULT (datetime('now'))
);
