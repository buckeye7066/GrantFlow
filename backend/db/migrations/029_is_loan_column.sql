-- Add is_loan to funding_opportunities for loan/grants filtering.
-- Loans and matching-required funds are excluded from discovery and matching.
ALTER TABLE funding_opportunities ADD COLUMN is_loan INTEGER DEFAULT 0;
