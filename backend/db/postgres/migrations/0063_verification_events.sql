-- 0063_verification_events.sql
-- Append-only audit log of URL verification probes. Postgres mirror of
-- backend/db/migrations/069_verification_events.sql.

CREATE TABLE IF NOT EXISTS verification_events (
  id BIGSERIAL PRIMARY KEY,
  opportunity_id TEXT,
  source TEXT,
  url TEXT,
  link_status TEXT,
  link_status_code INTEGER,
  verification_method TEXT,
  verified_by TEXT,
  verification_error TEXT,
  duration_ms INTEGER,
  ts TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verification_events_opportunity_id
  ON verification_events(opportunity_id);

CREATE INDEX IF NOT EXISTS idx_verification_events_ts
  ON verification_events(ts);

CREATE INDEX IF NOT EXISTS idx_verification_events_status
  ON verification_events(link_status);
