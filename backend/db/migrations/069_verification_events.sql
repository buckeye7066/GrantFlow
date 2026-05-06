-- 069_verification_events.sql
--
-- Reality gate phase 1.5: append-only audit log of every URL verification
-- event. Lets us answer:
--   * "When was this opportunity last actually probed?"
--   * "How many of yesterday's bulk inserts actually got verified?"
--   * "What's the broken-link rate per source?"
--
-- We never UPDATE this table; we only INSERT. Aggregations roll it up.

CREATE TABLE IF NOT EXISTS verification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT,
  source TEXT,
  url TEXT,
  link_status TEXT,                  -- ok | redirect | broken | skipped | unverified
  link_status_code INTEGER,          -- HTTP status code (nullable)
  verification_method TEXT,          -- head | get | api | manual | crawler:<name>
  verified_by TEXT,                  -- worker/job that performed the check
  verification_error TEXT,           -- last error text (broken only)
  duration_ms INTEGER,               -- how long the probe took
  ts DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_verification_events_opportunity_id
  ON verification_events(opportunity_id);

CREATE INDEX IF NOT EXISTS idx_verification_events_ts
  ON verification_events(ts);

CREATE INDEX IF NOT EXISTS idx_verification_events_status
  ON verification_events(link_status);
