-- 050_link_verification.sql
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS last_verified_at TEXT DEFAULT NULL;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS link_status TEXT DEFAULT 'unverified' CHECK (link_status IN ('ok', 'broken', 'redirect', 'unverified', 'skipped'));
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS link_status_code INTEGER DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_funding_opps_link_status ON funding_opportunities(link_status);
CREATE INDEX IF NOT EXISTS idx_funding_opps_last_verified ON funding_opportunities(last_verified_at);
