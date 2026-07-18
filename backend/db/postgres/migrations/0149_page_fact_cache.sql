-- Content-addressed page-fact cache (Phase 0.2 of the web-lane de-contamination
-- program). Twin of sqlite migration 145_page_fact_cache.sql.
--
-- ADDITIVE, default-off, ZERO behavior change. Gives a LATER phase's
-- profile-blind extractor a deterministic "same page => same facts" store so an
-- extraction can be reused across profiles instead of re-calling the LLM.
-- NOTHING in the live path writes or reads this table yet (wired in Phase 1).
-- The cache_key is a stable hash of (normalized_final_url, content_hash,
-- extractor_version, prompt_version, model); the five components are stored as
-- their own columns only for debuggability. CREATE TABLE IF NOT EXISTS is
-- idempotent and safe on an existing DB.
CREATE TABLE IF NOT EXISTS page_fact_cache (
  cache_key TEXT PRIMARY KEY,
  normalized_final_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  page_facts_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
