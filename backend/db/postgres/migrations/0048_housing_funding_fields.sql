-- Migration 0048: Housing-aware funding classification fields (Postgres)

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS funding_category TEXT,
  ADD COLUMN IF NOT EXISTS usable_for_housing BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS refund_potential BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS eligibility_signals JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'needs_review';

CREATE INDEX IF NOT EXISTS idx_fo_funding_category ON funding_opportunities(funding_category);
CREATE INDEX IF NOT EXISTS idx_fo_usable_for_housing ON funding_opportunities(usable_for_housing);
CREATE INDEX IF NOT EXISTS idx_fo_verification_status ON funding_opportunities(verification_status);
