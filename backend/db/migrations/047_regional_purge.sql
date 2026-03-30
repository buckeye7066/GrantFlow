-- Regional purge system: suppression state tracking
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN with try-catch at the app level)

-- ─────────────────────────────────────────────────────────────
-- Columns added to funding_opportunities (SQLite / Postgres)
-- ─────────────────────────────────────────────────────────────
-- NOTE: ALTER TABLE … ADD COLUMN is idempotent here because
-- the migration runner skips columns that already exist.
-- These statements are intentionally placed so the migration
-- runner can handle "duplicate column" errors gracefully.

ALTER TABLE funding_opportunities ADD COLUMN last_seen_text TEXT;
ALTER TABLE funding_opportunities ADD COLUMN last_seen_hash TEXT;
ALTER TABLE funding_opportunities ADD COLUMN last_checked_at DATETIME;
ALTER TABLE funding_opportunities ADD COLUMN suppression_state TEXT DEFAULT 'active';
ALTER TABLE funding_opportunities ADD COLUMN suppression_reason TEXT;
ALTER TABLE funding_opportunities ADD COLUMN suppression_metadata TEXT;
ALTER TABLE funding_opportunities ADD COLUMN last_status TEXT;
ALTER TABLE funding_opportunities ADD COLUMN last_deadline DATE;
ALTER TABLE funding_opportunities ADD COLUMN source_tier TEXT DEFAULT 'unknown';

-- ─────────────────────────────────────────────────────────────
-- Durable suppression event log
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opportunity_suppression_events (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  opportunity_id      TEXT NOT NULL,
  previous_state      TEXT NOT NULL DEFAULT 'active',
  new_state           TEXT NOT NULL,
  reason              TEXT,
  similarity          REAL,
  token_diff_ratio    REAL,
  verification_signals TEXT,
  source_url          TEXT,
  checked_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  actor               TEXT DEFAULT 'regional_purge',
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_suppression_events_opp
  ON opportunity_suppression_events(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_suppression_events_checked
  ON opportunity_suppression_events(checked_at);
CREATE INDEX IF NOT EXISTS idx_suppression_events_state
  ON opportunity_suppression_events(new_state);
