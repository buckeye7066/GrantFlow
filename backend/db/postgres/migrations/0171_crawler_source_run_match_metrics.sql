-- Postgres twin of SQLite migration 166.
--
-- Per-source match telemetry for the admin Crawl Coverage dashboard's
-- Accepted / Rejected / Avg-match columns, which showed "—" for every run
-- because nothing durable recorded them. NULL = "row predates the metric"
-- (unknown), which the route reports separately from a real zero.

ALTER TABLE crawler_source_runs
  ADD COLUMN IF NOT EXISTS parsed_candidates INTEGER,
  ADD COLUMN IF NOT EXISTS rejected          INTEGER,
  ADD COLUMN IF NOT EXISTS accepted          INTEGER,
  ADD COLUMN IF NOT EXISTS match_score_sum   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS match_score_n     INTEGER;
