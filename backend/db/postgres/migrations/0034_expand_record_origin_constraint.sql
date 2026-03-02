-- Migration 0034: Expand record_origin CHECK constraint
-- 
-- The original constraint only allowed: live_crawl, curated_verified, manual, synthetic
-- But crawlers produce additional values like directory_resource, discovered, funding_api, etc.
-- This caused every Grants.gov crawl (and other crawlers) to fail with:
--   "new row for relation funding_opportunities violates check constraint
--    funding_opportunities_record_origin_check"
--
-- Fix: Drop the old constraint and replace with an expanded one covering all
-- values the crawler pipeline can produce.

-- Step 1: Drop the existing overly-restrictive constraint
ALTER TABLE funding_opportunities
  DROP CONSTRAINT IF EXISTS funding_opportunities_record_origin_check;

-- Step 2: Add the expanded constraint with all valid record_origin values
ALTER TABLE funding_opportunities
  ADD CONSTRAINT funding_opportunities_record_origin_check
  CHECK (record_origin IN (
      'live_crawl',
      'curated_verified',
      'manual',
      'synthetic',
      'directory_resource',
      'discovered',
      'funding_api',
      'geo_crawl',
      'seeded',
      'imported'
    ));

-- Step 3: Fix any existing rows that might have non-conforming values
-- Map any truly unknown values to 'live_crawl' (the safest default)
UPDATE funding_opportunities
  SET record_origin = 'live_crawl'
  WHERE record_origin IS NULL
     OR record_origin NOT IN (
         'live_crawl', 'curated_verified', 'manual', 'synthetic',
         'directory_resource', 'discovered', 'funding_api',
         'geo_crawl', 'seeded', 'imported'
       );
