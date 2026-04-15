-- Index for "recently added" sort on discovery pages
CREATE INDEX IF NOT EXISTS idx_fo_created_at ON funding_opportunities(created_at DESC);
