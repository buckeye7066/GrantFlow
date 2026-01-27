-- Migration 0021: Add health_resources crawler job type (Postgres)
-- Date: 2026-01-27

DO $$
DECLARE
  constraint_name text;
BEGIN
  -- Drop any existing CHECK constraint on crawler_jobs.type (name may vary).
  SELECT c.conname
  INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'crawler_jobs'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%CHECK%'
    AND pg_get_constraintdef(c.oid) ILIKE '%type%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE crawler_jobs DROP CONSTRAINT IF EXISTS %I', constraint_name);
  END IF;
END $$;

ALTER TABLE crawler_jobs
  ADD CONSTRAINT crawler_jobs_type_check
  CHECK(type IN (
    'local',
    'scholarship',
    'health_resources',
    'comprehensive',
    'national',
    'item_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
    'national_zip_scan'
  ));

