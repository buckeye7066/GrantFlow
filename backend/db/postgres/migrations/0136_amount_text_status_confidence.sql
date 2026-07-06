-- Amount visibility: best-available amount TEXT + explicit status + extraction
-- confidence, on both the catalog and the pipeline. Twin of sqlite migration
-- 132_amount_text_status_confidence.sql.
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS amount_text TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS amount_status TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS amount_confidence REAL;

ALTER TABLE grants ADD COLUMN IF NOT EXISTS amount_text TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS amount_status TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS amount_confidence REAL;
