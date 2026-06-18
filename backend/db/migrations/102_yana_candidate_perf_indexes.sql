-- 102_yana_candidate_perf_indexes.sql (SQLite)
--
-- Indexes backing Yana's optimized hot loops:
--   - ux_yana_candidates_source_extid: the ON CONFLICT target for the prospect
--     upsert (upsertProspectCandidate). Partial (external_id IS NOT NULL) so it
--     never collides with own-org rows (external_id NULL), which keep deduping
--     on UNIQUE(organization_id).
--   - idx_yana_candidates_push: covers pushQualifiedToJohn's
--     "qualified, not pushed, highest lead_score first" selection.
--
-- Idempotent (IF NOT EXISTS) and also created defensively at boot via
-- ensureSchema, so re-applying is harmless.

CREATE UNIQUE INDEX IF NOT EXISTS ux_yana_candidates_source_extid
  ON yana_lead_candidates(source, external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_yana_candidates_push
  ON yana_lead_candidates(qualification_status, pushed_to_john, lead_score);
