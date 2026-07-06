-- Amount visibility: best-available amount TEXT + explicit status + extraction
-- confidence, on both the catalog and the pipeline. When no per-award dollar
-- figure is knowable, the row carries honest text ("amounts vary", "contact
-- funder", program-total excerpt) instead of a silent blank.
-- Populated at ingest by awardAmountExtractor.resolveOpportunityAmounts and
-- backfilled onto grants by enforceGrantAmountBackfill().
ALTER TABLE funding_opportunities ADD COLUMN amount_text TEXT;
ALTER TABLE funding_opportunities ADD COLUMN amount_status TEXT;
ALTER TABLE funding_opportunities ADD COLUMN amount_confidence REAL;

ALTER TABLE grants ADD COLUMN amount_text TEXT;
ALTER TABLE grants ADD COLUMN amount_status TEXT;
ALTER TABLE grants ADD COLUMN amount_confidence REAL;
