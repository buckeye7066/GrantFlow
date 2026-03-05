-- Add funding_type column to funding_opportunities for pro bono / in-kind classification
-- Values: 'cash', 'service', 'cost_coverage', 'referral', or NULL (defaults to cash-equivalent)
ALTER TABLE funding_opportunities ADD COLUMN funding_type TEXT;
