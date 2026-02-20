-- Add amount_min and amount_max to grants for UI/API compatibility (pipeline cards, GrantForm, Reports).
-- Fixes: "column amount_max does not exist" on Grant Detail / AI Proposal Coach and related 500s.

ALTER TABLE grants ADD COLUMN IF NOT EXISTS amount_min DOUBLE PRECISION;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS amount_max DOUBLE PRECISION;
