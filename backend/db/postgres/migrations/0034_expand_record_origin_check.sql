-- Migration 0034: Expand record_origin CHECK constraint
--
-- The original constraint only allowed 4 values:
--   ('live_crawl','curated_verified','manual','synthetic')
--
-- But 5 additional values are used in production code:
--   'directory:health_resources'  — healthResourcesCrawler.js
--   'directory:student_grants'    — studentGrantsCrawler.js
--   'directory_resource'          — crawlerOpportunityContract.js (fallback)
--   'funding_api'                 — grantsDotGovCrawler.js
--   'url_import'                  — extractOpportunitiesFromDocumentText.js
--
-- Any INSERT with these values silently fails with a CHECK violation,
-- which is the likely cause of the job queue worker dying.

-- Drop the old constraint
ALTER TABLE funding_opportunities
  DROP CONSTRAINT IF EXISTS funding_opportunities_record_origin_check;

-- Add the expanded constraint
ALTER TABLE funding_opportunities
  ADD CONSTRAINT funding_opportunities_record_origin_check
  CHECK (record_origin IN (
    'live_crawl',
    'curated_verified',
    'manual',
    'synthetic',
    'funding_api',
    'url_import',
    'directory_resource',
    'directory:health_resources',
    'directory:student_grants'
  ));
