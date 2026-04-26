-- Repair environments where link verification metadata was not added to
-- funding_opportunities but saved-grants/trust queries already read it.
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS link_status TEXT DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_funding_opps_link_status ON funding_opportunities(link_status);
