-- Regional purge system: suppression state tracking (PostgreSQL)
-- Use ALTER TABLE … ADD COLUMN IF NOT EXISTS for safety

ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS last_seen_text TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS last_seen_hash TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS suppression_state TEXT DEFAULT 'active';
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS suppression_reason TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS suppression_metadata JSONB;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS last_status TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS last_deadline DATE;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS source_tier TEXT DEFAULT 'unknown';

-- Durable suppression event log
CREATE TABLE IF NOT EXISTS opportunity_suppression_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id      TEXT NOT NULL,
  previous_state      TEXT NOT NULL DEFAULT 'active',
  new_state           TEXT NOT NULL,
  reason              TEXT,
  similarity          DOUBLE PRECISION,
  token_diff_ratio    DOUBLE PRECISION,
  verification_signals JSONB,
  source_url          TEXT,
  checked_at          TIMESTAMPTZ DEFAULT NOW(),
  actor               TEXT DEFAULT 'regional_purge',
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_suppression_events_opp
  ON opportunity_suppression_events(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_suppression_events_checked
  ON opportunity_suppression_events(checked_at);
CREATE INDEX IF NOT EXISTS idx_suppression_events_state
  ON opportunity_suppression_events(new_state);
