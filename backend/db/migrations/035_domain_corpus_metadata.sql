-- Domain corpus metadata for funding_opportunities (National Funding Aggregator).
-- Ensures backward compatibility: add columns only if they don't exist.
-- SQLite: ADD COLUMN fails silently if column exists in some versions; we rely on migration order.

ALTER TABLE funding_opportunities ADD COLUMN funding_domain TEXT;
ALTER TABLE funding_opportunities ADD COLUMN funding_subdomain TEXT;
ALTER TABLE funding_opportunities ADD COLUMN source_category TEXT;
ALTER TABLE funding_opportunities ADD COLUMN compliance_required TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN certifications_required TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN geo_eligibility TEXT;
ALTER TABLE funding_opportunities ADD COLUMN signal_tags TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN verified_url INTEGER DEFAULT 0;
ALTER TABLE funding_opportunities ADD COLUMN crawler_version TEXT;

-- last_verified_at already exists in schema; verified_url is new.
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_funding_domain ON funding_opportunities(funding_domain);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_funding_subdomain ON funding_opportunities(funding_subdomain);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_verified_url ON funding_opportunities(verified_url);
