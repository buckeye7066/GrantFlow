-- Per-row LAST enrich-outcome reason. Twin of sqlite migration
-- 153_amount_enrich_last_reason.sql — see it for the full rationale.
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS amount_enrich_last_reason TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS amount_enrich_last_reason TEXT;
