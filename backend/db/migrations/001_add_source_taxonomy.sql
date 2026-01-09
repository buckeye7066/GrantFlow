-- Migration: Add source taxonomy to funding_opportunities
-- Date: 2026-01-09
-- Description: Adds type, evidence_url, and last_verified_at columns to distinguish
--              OPPORTUNITY (open grants) from PROGRAM (standing assistance) and DIRECTORY (listings)

-- Add type column with CHECK constraint
ALTER TABLE funding_opportunities ADD COLUMN type TEXT DEFAULT 'OPPORTUNITY' CHECK(type IN ('OPPORTUNITY', 'PROGRAM', 'DIRECTORY'));

-- Add evidence tracking columns
ALTER TABLE funding_opportunities ADD COLUMN evidence_url TEXT;
ALTER TABLE funding_opportunities ADD COLUMN last_verified_at DATETIME;

-- Update existing records to have default type
UPDATE funding_opportunities SET type = 'OPPORTUNITY' WHERE type IS NULL;

-- Create index for efficient type filtering
CREATE INDEX IF NOT EXISTS idx_opportunities_type ON funding_opportunities(type);

-- Migration complete
-- All existing opportunities default to 'OPPORTUNITY' type
-- New records must explicitly set type based on verification
