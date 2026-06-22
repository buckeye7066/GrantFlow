-- @sqlite-continue-on-idempotent-errors
-- Crawler OS durable cross-source / cross-run dedup (SQLite). Postgres parity:
--   backend/db/postgres/migrations/0122_crawler_os_canonical_dedup.sql
--
-- The legacy catalog deduped only within a single run. The Crawler OS makes
-- dedup permanent by persisting a source-INDEPENDENT canonical key on every
-- opportunity (contract.canonicalOpportunityKey) and consulting it on every
-- write (storage.upsertOpportunity). The same real opportunity surfaced by
-- grants_gov this week and fema_afg next week collapses to ONE catalog row;
-- opportunity_sources preserves which crawler(s) found it.
--
-- Additive + idempotent. Legacy rows keep canonical_opportunity_key = NULL until
-- re-discovered by the new pipeline (SQLite/Postgres both treat NULLs as
-- distinct under a UNIQUE index, so existing rows never collide).

ALTER TABLE funding_opportunities ADD COLUMN canonical_opportunity_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fo_canonical_key
  ON funding_opportunities(canonical_opportunity_key);

CREATE TABLE IF NOT EXISTS opportunity_sources (
  opportunity_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT,
  apply_url TEXT,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (opportunity_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_opp_sources_opp ON opportunity_sources(opportunity_id);
