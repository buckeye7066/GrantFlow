-- Opportunity identity aliases + conflicts (Phase 2.1 of the web-lane
-- de-contamination program). Twin: the postgres opportunity_identity_tables
-- migration.
--
-- ADDITIVE, default-off, ZERO behavior change. Durable identity bookkeeping for
-- a LATER phase's cross-run opportunity identity resolution:
--   - opportunity_identity_aliases maps a (scheme, identity_key) — e.g. a
--     normalized URL or an external id under a named scheme — to the ONE
--     opportunity it has been observed to denote. UNIQUE(scheme, identity_key)
--     is the invariant: an identity key never points at two opportunities.
--   - opportunity_identity_conflicts records the times the world DISAGREED:
--     the same (scheme, identity_key) observed on two different opportunities.
--     The PARTIAL unique index (WHERE status = 'open') means re-observing a
--     known conflict updates the ONE open row instead of inserting a second,
--     while a RESOLVED conflict leaves room for a genuinely new open one.
-- NOTHING in the live path writes or reads these tables yet (wired in a later
-- sub-PR); this PR only adds the tables + a pure accessor
-- (backend/services/opportunityIdentityStore.js).
--
-- CREATE TABLE/INDEX IF NOT EXISTS is naturally idempotent, so this needs no
-- @sqlite-continue-on-idempotent-errors directive and is safe on an existing
-- DB. On a fresh SQLite DB schema.sql already creates these tables, so the
-- runner records this as an already-applied no-op.
CREATE TABLE IF NOT EXISTS opportunity_identity_aliases (
  scheme TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scheme, identity_key)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_identity_aliases_opportunity
  ON opportunity_identity_aliases(opportunity_id);

CREATE TABLE IF NOT EXISTS opportunity_identity_conflicts (
  id TEXT PRIMARY KEY,
  scheme TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  opportunity_id_a TEXT NOT NULL,
  opportunity_id_b TEXT NOT NULL,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved_merged', 'resolved_distinct', 'dismissed')),
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_opportunity_identity_conflicts_one_open
  ON opportunity_identity_conflicts(scheme, identity_key)
  WHERE status = 'open';
