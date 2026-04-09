-- Add funding_source_type column for filtering by funder category
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS funding_source_type TEXT;
CREATE INDEX IF NOT EXISTS idx_fo_funding_source_type ON funding_opportunities(funding_source_type);

-- Backfill from record_origin and source
UPDATE funding_opportunities SET funding_source_type = CASE
  WHEN record_origin = 'grants_gov' OR source IN ('grants.gov', 'grants_gov', 'usa_spending', 'usaspending') THEN 'federal'
  WHEN source IN ('state_portal', 'state_grants_portal', 'state_waiver') THEN 'state'
  WHEN record_origin IN ('curated_benefits', 'curated_program') AND source LIKE '%state%' THEN 'state'
  WHEN source IN ('local_foundation', 'community_foundation', 'cof_foundation_locator', 'candid_directory', 'propublica.990') THEN 'foundation'
  WHEN source = 'corporate_giving' THEN 'corporate'
  WHEN source IN ('scholarship_crawler', 'scholarship_database', 'school_portal') THEN 'university'
  WHEN source IN ('health_resources_crawler', 'charity_care') THEN 'medical'
  WHEN source LIKE 'local_directory_%' OR source = 'osm_overpass' THEN 'community'
  WHEN record_origin IN ('curated_benefits', 'curated_verified', 'verified_real', 'curated_program') THEN 'federal'
  ELSE 'other'
END
WHERE funding_source_type IS NULL;
