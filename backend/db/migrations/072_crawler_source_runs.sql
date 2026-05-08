-- 072_crawler_source_runs.sql
--
-- Mission Goal 9 (explainable, reliable, testable) — per-source
-- outcomes for every real crawler run, so mission health and Anya
-- can answer "did we actually query Grants.gov for this profile, or
-- only plan to?". Recorded by backend/routes/realCrawlers.js after
-- buildCoverageReport. SQLite version.

CREATE TABLE IF NOT EXISTS crawler_source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crawler_run_id TEXT NOT NULL,
  profile_id TEXT,
  crawler_type TEXT,
  source_id TEXT NOT NULL,
  source_label TEXT,
  planned INTEGER NOT NULL DEFAULT 0,
  queried INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  directory INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_csr_run ON crawler_source_runs(crawler_run_id);
CREATE INDEX IF NOT EXISTS idx_csr_profile ON crawler_source_runs(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_csr_source_recent ON crawler_source_runs(source_id, created_at);
