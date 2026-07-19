-- Attempt-tracking for DIRECT grant amount enrichment.
-- Twin of sqlite migration 142_grant_amount_enrich_tracking.sql — see it for the
-- full rationale. A grant with a URL but no catalog twin is read directly by
-- `enforceGrantDirectAmountEnrichment`, which records the answer on the grant;
-- these columns are the same permanent one-shot mark the catalog sweep uses on
-- `funding_opportunities`, so a page that yields nothing is not re-fetched nightly.
ALTER TABLE grants ADD COLUMN IF NOT EXISTS amount_enrich_attempted_at TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS amount_enrich_attempts INTEGER DEFAULT 0;
