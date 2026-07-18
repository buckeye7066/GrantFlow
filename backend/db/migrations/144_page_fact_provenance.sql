-- Page-fact provenance (Phase 0.1 of the web-lane de-contamination program).
-- Twin: postgres migration 0148_page_fact_provenance.sql.
--
-- ADDITIVE + NULL-default plumbing. Adds durable storage for what a source page
-- literally stated about an opportunity, with per-field evidence, so a LATER
-- profile-blind extractor can populate it. NOTHING writes these columns yet:
-- they default NULL and change no matching / scoring / behavior. This is the
-- FOUNDATION PR — plumbing only.
--
--   eligibility_text          : the raw eligibility prose scraped off the page.
--   page_fact_schema_version  : which extractor schema produced the page facts.
--   field_provenance          : JSON { field: { value, evidence_snippet, source } }.
--
-- eligibility_bullets already exists (schema.sql / pg 0001_init) and is NOT
-- re-added here. TRI-STATE for is_loan / requires_match (cost share) /
-- is_national lives in field_provenance: an ABSENT key means "not stated",
-- distinct from those boolean columns' coalesced false — existing consumers keep
-- reading the boolean columns unchanged.
--
-- On a fresh SQLite DB schema.sql already creates these columns, so the migrate
-- runner records this as an idempotent already-applied no-op; on an existing DB
-- the ALTERs add them.
ALTER TABLE funding_opportunities ADD COLUMN eligibility_text TEXT;
ALTER TABLE funding_opportunities ADD COLUMN page_fact_schema_version INTEGER;
ALTER TABLE funding_opportunities ADD COLUMN field_provenance TEXT;
