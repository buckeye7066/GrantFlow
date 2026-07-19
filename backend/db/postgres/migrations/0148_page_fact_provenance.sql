-- Page-fact provenance (Phase 0.1 of the web-lane de-contamination program).
-- Twin of sqlite migration 144_page_fact_provenance.sql.
--
-- ADDITIVE + NULL-default plumbing: durable storage for what a source page
-- literally stated, with per-field evidence, for a LATER profile-blind
-- extractor. Nothing writes these yet — they default NULL and change no
-- behavior. eligibility_bullets already exists (0001_init); TRI-STATE for
-- is_loan / requires_match / is_national lives in field_provenance (an absent
-- key = "not stated", distinct from the boolean columns' coalesced false).
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS eligibility_text TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS page_fact_schema_version INTEGER;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS field_provenance TEXT;
