-- 0066_crawler_source_runs.sql
--
-- Mission Goal 9 (explainable, reliable, testable) — per-source
-- outcomes for every real crawler run. Postgres mirror of
-- backend/db/migrations/072_crawler_source_runs.sql.

CREATE TABLE IF NOT EXISTS crawler_source_runs (
  id            BIGSERIAL PRIMARY KEY,
  crawler_run_id TEXT       NOT NULL,
  profile_id     TEXT,
  crawler_type   TEXT,
  source_id      TEXT       NOT NULL,
  source_label   TEXT,
  planned        BOOLEAN    NOT NULL DEFAULT FALSE,
  queried        BOOLEAN    NOT NULL DEFAULT FALSE,
  failed         BOOLEAN    NOT NULL DEFAULT FALSE,
  found          INTEGER    NOT NULL DEFAULT 0,
  directory      BOOLEAN    NOT NULL DEFAULT FALSE,
  duration_ms    INTEGER,
  error          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_csr_run            ON crawler_source_runs(crawler_run_id);
CREATE INDEX IF NOT EXISTS idx_csr_profile_recent ON crawler_source_runs(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_csr_source_recent  ON crawler_source_runs(source_id, created_at);
