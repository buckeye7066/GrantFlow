-- Twin of SQLite migration 176. See that file for rationale.
CREATE TABLE IF NOT EXISTS hamilton_inbound_sms (
  id TEXT PRIMARY KEY,
  sender TEXT,
  body TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hamilton_inbound_sms_received
  ON hamilton_inbound_sms (received_at DESC);
