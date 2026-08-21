-- Twin of SQLite migration 178. See that file for rationale.
ALTER TABLE hamilton_inbound_sms ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE hamilton_inbound_sms ADD COLUMN IF NOT EXISTS subject TEXT;
UPDATE hamilton_inbound_sms SET channel = 'sms' WHERE channel IS NULL OR TRIM(channel) = '';
CREATE INDEX IF NOT EXISTS idx_hamilton_inbound_sms_channel_received
  ON hamilton_inbound_sms (channel, received_at DESC);
