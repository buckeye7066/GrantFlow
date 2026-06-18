-- 0099_yana_candidate_perf_indexes.sql (Postgres)
--
-- See the SQLite twin (102_yana_candidate_perf_indexes.sql). Indexes backing
-- Yana's optimized hot loops: the prospect upsert's ON CONFLICT target and the
-- highest-value-first push selection. Idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS ux_yana_candidates_source_extid
  ON yana_lead_candidates(source, external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_yana_candidates_push
  ON yana_lead_candidates(qualification_status, pushed_to_john, lead_score);
