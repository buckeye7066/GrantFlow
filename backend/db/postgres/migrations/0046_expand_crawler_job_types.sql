-- Migration 0046: Allow curated_* and related job types in crawler_jobs.type (Postgres)
-- Aligns DB CHECK with backend/services/crawlerDispatcher.js HANDLERS + createCrawlerJob validation.

DO $$
DECLARE
  constraint_name text;
BEGIN
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
    'curated_benefits',
    'health_resources',
    'comprehensive',
    'national',
    'item_search',
    'item_gift_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
    'national_zip_scan',
    'portal_check',
    'government_funding',
    'student_grants',
    'ecf_benefits',
    'special_needs',
    'local_funding',
    'item_matching'
  ));
