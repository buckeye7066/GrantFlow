-- 181: SQLite twin of postgres 0186 (drop the misplaced
-- yana_autopilot_runs_status_check stranded on hamilton_autopilot_runs).
--
-- SQLite's schema never carried the misplaced named constraint (its CHECKs
-- are inline and unnamed, and the local schema was rebuilt by 180), so there
-- is nothing to drop here — this file exists so the migration SETS stay in
-- name parity across dialects (grantflow-migration-set-v2 contract).
SELECT 1;
