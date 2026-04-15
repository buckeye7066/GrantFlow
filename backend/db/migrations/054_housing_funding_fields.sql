-- Migration 054: Housing-aware funding classification fields
-- Adds fields needed to identify scholarships/grants usable for off-campus living expenses.

-- Funding category enum (stored as TEXT with application-layer validation)
--   tuition_only      – funds disbursed directly to institution, no refund pathway
--   refund_eligible   – funds may exceed tuition and generate a student refund
--   stipend           – program pays student directly (monthly / per semester)
--   housing_direct    – program pays housing costs directly (RA, campus job stipend)
--   faith_based       – offered by a religious organisation or denomination
--   talent_based      – merit-based on a specific talent (music, athletics, art)
--   coa_adjustment    – COA (Cost of Attendance) increase / appeal pathway

ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS funding_category TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS usable_for_housing INTEGER DEFAULT 0;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS refund_potential INTEGER DEFAULT 0;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS eligibility_signals TEXT DEFAULT '{}';
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'needs_review';

CREATE INDEX IF NOT EXISTS idx_fo_funding_category ON funding_opportunities(funding_category);
CREATE INDEX IF NOT EXISTS idx_fo_usable_for_housing ON funding_opportunities(usable_for_housing);
CREATE INDEX IF NOT EXISTS idx_fo_verification_status ON funding_opportunities(verification_status);
