-- Domain corpus metadata for funding_opportunities (National Funding Aggregator).
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS funding_domain TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS funding_subdomain TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS source_category TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS compliance_required TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS certifications_required TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS geo_eligibility TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS signal_tags TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS verified_url BOOLEAN DEFAULT FALSE;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS crawler_version TEXT;

CREATE INDEX IF NOT EXISTS idx_funding_opportunities_funding_domain ON funding_opportunities(funding_domain);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_funding_subdomain ON funding_opportunities(funding_subdomain);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_verified_url ON funding_opportunities(verified_url);
