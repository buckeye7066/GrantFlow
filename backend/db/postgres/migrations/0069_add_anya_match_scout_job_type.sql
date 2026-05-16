-- Migration 0069: Allow 'anya_match_scout' job type in crawler_jobs.type (Postgres)
-- Mirrors backend/services/crawlerDispatcher.js HANDLERS + createCrawlerJob.VALID_TYPES.
--
-- The anya_match_scout crawler job runs the Anya Match Scout for one
-- profile: it scans for high-confidence (>=85%) opportunity matches and
-- writes pending rows to `anya_match_suggestions` + a notification.
-- It NEVER auto-adds to the pipeline.

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
    'student_bridge_funding',
    'ecf_benefits',
    'special_needs',
    'local_funding',
    'item_matching',
    'anya_match_scout'
  ));
