-- Attempt-tracking for DIRECT grant amount enrichment.
-- Twin: postgres migration 0146_grant_amount_enrich_tracking.sql.
--
-- The amount-enrichment sweep and the coverage census both reach a grant only
-- through its linked catalog row (`funding_opportunity_id`). A grant with a URL
-- but no catalog twin (Eldercare Locator, Coca-Cola Scholars, FAFSA — curated
-- resources inserted directly as grants, prod 2026-07-17: 43 of them) is
-- therefore never read by anything, and shows in `pipeline.amountCoverage` as an
-- unanswerable `unanswered_no_catalog_row`.
--
-- `enforceGrantDirectAmountEnrichment` reads such a grant's OWN url and records
-- the answer on the grant itself (an amount, or an evidenced `none_published`).
-- It needs the same permanent one-shot mark the catalog sweep uses, so a page
-- that yields nothing is not re-fetched every boot. Mirrors the catalog columns
-- (`funding_opportunities.amount_enrich_attempted_at` / `amount_enrich_attempts`,
-- migrations 136/137) exactly, so the burn/retry logic is identical.
ALTER TABLE grants ADD COLUMN amount_enrich_attempted_at TEXT;
ALTER TABLE grants ADD COLUMN amount_enrich_attempts INTEGER DEFAULT 0;
