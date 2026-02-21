-- Add is_loan to funding_opportunities for loan/grants filtering.
-- Loans and matching-required funds are excluded from discovery and matching.
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS is_loan BOOLEAN DEFAULT FALSE;
