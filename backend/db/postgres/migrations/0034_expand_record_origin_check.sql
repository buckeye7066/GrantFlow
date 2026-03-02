-- Migration 0034: Expand record_origin CHECK constraint
--
-- The original constraint only allowed 4 values:
--   ('live_crawl','curated_verified','manual','synthetic')
--
-- But many additional values are used across crawlers:
--   'directory:health_resources'  — healthResourcesCrawler.js
--   'directory:student_grants'    — studentGrantsCrawler.js
--   'directory_resource'          — crawlerOpportunityContract.js (fallback)
--   'funding_api'                 — grantsDotGovCrawler.js
--   'url_import'                  — extractOpportunitiesFromDocumentText.js
--   'discovered'                  — discovery crawlers
--   'geo_crawl'                   — geo-based crawlers
--   'seeded'                      — seeded data
--   'imported'                    — bulk imports
--
-- Any INSERT with these values fails with a CHECK violation,
-- silently killing bulkUpsertFundingOpportunities.

-- Drop the old constraint
ALTER TABLE funding_opportunities
  DROP CONSTRAINT IF EXISTS funding_opportunities_record_origin_check;

-- Add the expanded constraint with ALL valid record_origin values
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
    'directory:student_grants',
    'discovered',
    'geo_crawl',
    'seeded',
    'imported'
  ));

-- Fix any existing rows with non-conforming values
UPDATE funding_opportunities
  SET record_origin = 'live_crawl'
  WHERE record_origin IS NULL
     OR record_origin NOT IN (
         'live_crawl', 'curated_verified', 'manual', 'synthetic',
         'funding_api', 'url_import', 'directory_resource',
         'directory:health_resources', 'directory:student_grants',
         'discovered', 'geo_crawl', 'seeded', 'imported'
       );
