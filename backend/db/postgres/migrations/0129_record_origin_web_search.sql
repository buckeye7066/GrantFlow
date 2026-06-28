-- Migration 0129: allow profile-reviewed live web leads to keep web_search provenance.
--
-- These records are not treated as verified funding by default. They still flow
-- through quality, reviewer, reality, and match gates before catalog/pipeline use.

ALTER TABLE funding_opportunities
  DROP CONSTRAINT IF EXISTS funding_opportunities_record_origin_check;

UPDATE funding_opportunities
  SET record_origin = 'live_crawl'
  WHERE record_origin IS NULL
     OR record_origin NOT IN (
       'live_crawl',
       'curated_verified',
       'curated_benefits',
       'curated_program',
       'curated_catalog',
       'scholarship_crawler',
       'school_portal',
       'grants_gov',
       'verified_real',
       'cof_foundation_locator',
       'manual',
       'synthetic',
       'funding_api',
       'clinical_trials',
       'url_import',
       'directory_resource',
       'directory:health_resources',
       'directory:student_grants',
       'discovered',
       'geo_crawl',
       'web_search',
       'seeded',
       'imported'
     );

ALTER TABLE funding_opportunities
  ADD CONSTRAINT funding_opportunities_record_origin_check
  CHECK (record_origin IN (
    'live_crawl',
    'curated_verified',
    'curated_benefits',
    'curated_program',
    'curated_catalog',
    'scholarship_crawler',
    'school_portal',
    'grants_gov',
    'verified_real',
    'cof_foundation_locator',
    'manual',
    'synthetic',
    'funding_api',
    'clinical_trials',
    'url_import',
    'directory_resource',
    'directory:health_resources',
    'directory:student_grants',
    'discovered',
    'geo_crawl',
    'web_search',
    'seeded',
    'imported'
  ));
