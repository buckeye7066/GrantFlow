-- Content-addressed page-fact cache (Phase 0.2 of the web-lane de-contamination
-- program). Twin: postgres migration 0149_page_fact_cache.sql.
--
-- ADDITIVE, default-off, ZERO behavior change. Gives a LATER phase's
-- profile-blind extractor a deterministic "same page => same facts" store so an
-- extraction can be reused across profiles instead of re-calling the LLM.
-- NOTHING in the live path writes or reads this table yet (wired in Phase 1);
-- this PR only adds the table + a pure accessor (backend/services/pageFactCache.js).
--
-- The cache_key is the content-addressed identity: a stable hash of
--   (normalized_final_url, content_hash, extractor_version, prompt_version, model)
-- computed by computeCacheKey(). Those five components are ALSO stored as their
-- own columns purely for debuggability (they are not consulted on read — the
-- cache_key PRIMARY KEY is the whole lookup).
--
-- CREATE TABLE IF NOT EXISTS is naturally idempotent, so this needs no
-- @sqlite-continue-on-idempotent-errors directive and is safe on an existing DB.
-- On a fresh SQLite DB schema.sql already creates this table, so the runner
-- records this as an already-applied no-op.
CREATE TABLE IF NOT EXISTS page_fact_cache (
  cache_key TEXT PRIMARY KEY,
  normalized_final_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  page_facts_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
