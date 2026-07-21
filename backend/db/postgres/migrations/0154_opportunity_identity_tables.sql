-- Opportunity identity aliases + conflicts (Phase 2.1 of the web-lane
-- de-contamination program). Twin of the sqlite opportunity_identity_tables
-- migration.
--
-- ADDITIVE, default-off, ZERO behavior change. Durable identity bookkeeping for
-- a LATER phase's cross-run opportunity identity resolution:
--   - opportunity_identity_aliases maps a (scheme, identity_key) to the ONE
--     opportunity it has been observed to denote; UNIQUE(scheme, identity_key)
--     is the invariant.
--   - opportunity_identity_conflicts records observed disagreements; the
--     PARTIAL unique index (WHERE status = 'open') keeps at most ONE open
--     conflict per (scheme, identity_key) while resolved rows accumulate.
--     opportunity_id_a/b stay the FIRST-observed pair; `participants` is the
--     JSON array of ALL distinct opportunity ids ever observed on the row.
-- The aliases UNIQUE constraint carries an EXPLICIT name: the accessor's
-- withIdentityTxn retry keys on it (error.constraint), so the name is API
-- surface, not decoration.
-- NOTHING in the live path writes or reads these tables yet (wired in a later
-- sub-PR). CREATE TABLE/INDEX IF NOT EXISTS is idempotent and safe on an
-- existing DB.
CREATE TABLE IF NOT EXISTS opportunity_identity_aliases (
  scheme TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_opportunity_identity_aliases_key UNIQUE (scheme, identity_key)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_identity_aliases_opportunity
  ON opportunity_identity_aliases(opportunity_id);

CREATE TABLE IF NOT EXISTS opportunity_identity_conflicts (
  id TEXT PRIMARY KEY,
  scheme TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  opportunity_id_a TEXT NOT NULL,
  opportunity_id_b TEXT NOT NULL,
  participants TEXT,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved_merged', 'resolved_distinct', 'dismissed')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_opportunity_identity_conflicts_one_open
  ON opportunity_identity_conflicts(scheme, identity_key)
  WHERE status = 'open';
