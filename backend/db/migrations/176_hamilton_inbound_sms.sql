-- Inbound SMS forwarded by the owner's phone (Tasker) so Hamilton can read the
-- one-time codes that portal signup sends to his number. Owner order
-- 2026-08-20. Nothing in the product can SEND a text or reach the handset;
-- this table only holds what the phone chose to forward.
CREATE TABLE IF NOT EXISTS hamilton_inbound_sms (
  id TEXT PRIMARY KEY,
  sender TEXT,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_inbound_sms_received
  ON hamilton_inbound_sms (received_at DESC);
