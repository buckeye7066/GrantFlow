-- 092_partial_geo_crawl_backfill.sql (SQLite)
--
-- Backfills crawler_jobs rows that were stamped `failed` even though their
-- own result_meta records real, durable progress (e.g. a geo crawl that
-- processed thousands of ZIPs and inserted tens of thousands of sources
-- before the worker died). Per mission rules, real persisted output is a
-- success, not a failure — these rows must read as `completed (partial)`
-- so the UI no longer mis-stamps them and so resume tooling can find them.
--
-- Reversibility: the original error is preserved as
-- result_meta.partial_error_legacy_backfill so an operator can audit /
-- revert a row by hand if needed.
--
-- Idempotent: the WHERE clause excludes rows that already carry
-- result_meta.partial = true, so re-running the migration is a no-op.

UPDATE crawler_jobs
SET status = 'completed',
    result_meta = json_set(
      json_set(
        json_set(
          COALESCE(result_meta, '{}'),
          '$.partial', json('true')
        ),
        '$.partial_reason', 'legacy_backfill'
      ),
      '$.partial_error_legacy_backfill',
      COALESCE(error, '')
    ),
    error = NULL
WHERE status = 'failed'
  AND result_meta IS NOT NULL
  AND COALESCE(json_extract(result_meta, '$.partial'), 0) IN (0, 'false')
  AND (
    COALESCE(CAST(json_extract(result_meta, '$.processed') AS INTEGER), 0) > 0
    OR COALESCE(CAST(json_extract(result_meta, '$.sources') AS INTEGER), 0) > 0
    OR COALESCE(CAST(json_extract(result_meta, '$.inserted') AS INTEGER), 0) > 0
    OR COALESCE(CAST(json_extract(result_meta, '$.inserted_new') AS INTEGER), 0) > 0
    OR COALESCE(result_count, 0) > 0
  );
