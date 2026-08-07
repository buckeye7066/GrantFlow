-- @sqlite-continue-on-idempotent-errors
-- 166_crawler_source_run_match_metrics.sql
--
-- The admin Crawl Coverage & Health dashboard rendered "—" in the Accepted /
-- Rejected / Avg-match columns for EVERY run while Found was populated. The
-- cause was write-side, not display-side: crawler_source_runs only ever stored
-- planned/queried/failed/found, and the route's two fallbacks could never work
-- (0 of 15,740 prod crawler_jobs.result_meta rows carry a crawler_run_id, and
-- rejection_log has no crawler_run_id column at all). The crawler already
-- computes these numbers per source per run — these columns are where they land.
--
-- match_score_sum/match_score_n travel instead of a pre-averaged score so the
-- run-level average can be aggregated across sources without weighting bias.
-- NULL means "this row predates the metric" (unknown) and must never be
-- rendered as 0. Postgres twin: 0171_crawler_source_run_match_metrics.sql

ALTER TABLE crawler_source_runs ADD COLUMN parsed_candidates INTEGER;
ALTER TABLE crawler_source_runs ADD COLUMN rejected INTEGER;
ALTER TABLE crawler_source_runs ADD COLUMN accepted INTEGER;
ALTER TABLE crawler_source_runs ADD COLUMN match_score_sum REAL;
ALTER TABLE crawler_source_runs ADD COLUMN match_score_n INTEGER;
