-- 0088_partial_geo_crawl_backfill.sql (Postgres)
--
-- Postgres counterpart to backend/db/migrations/092_partial_geo_crawl_backfill.sql.
-- Rewrites crawler_jobs rows that were stamped `failed` despite carrying real,
-- durable progress in result_meta (geo crawls that processed thousands of ZIPs
-- and inserted tens of thousands of sources before a worker death). Per mission
-- rules, real persisted output is success — these rows must read as
-- `completed (partial)` so the UI no longer misclassifies them and so resume
-- tooling can pick them up.
--
-- result_meta is stored as TEXT (see 0001_init.sql), so we cast to jsonb,
-- patch in the partial flags, and stringify back. Original error is preserved
-- as result_meta.partial_error_legacy_backfill for auditability.
--
-- Idempotent: the WHERE clause excludes rows already carrying partial=true.

UPDATE crawler_jobs
SET status = 'completed',
    result_meta = (
      jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(result_meta::jsonb, '{}'::jsonb),
            '{partial}', 'true'::jsonb, true
          ),
          '{partial_reason}', '"legacy_backfill"'::jsonb, true
        ),
        '{partial_error_legacy_backfill}',
        to_jsonb(COALESCE(error, '')),
        true
      )
    )::text,
    error = NULL
WHERE status = 'failed'
  AND result_meta IS NOT NULL
  AND result_meta <> ''
  AND (result_meta::jsonb -> 'partial') IS DISTINCT FROM 'true'::jsonb
  AND (
    COALESCE((result_meta::jsonb ->> 'processed')::numeric, 0) > 0
    OR COALESCE((result_meta::jsonb ->> 'sources')::numeric, 0) > 0
    OR COALESCE((result_meta::jsonb ->> 'inserted')::numeric, 0) > 0
    OR COALESCE((result_meta::jsonb ->> 'inserted_new')::numeric, 0) > 0
    OR COALESCE(result_count, 0) > 0
  );
