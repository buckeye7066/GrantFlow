-- Generalize the phone-forwarded inbox from SMS-only to SMS **and EMAIL**.
--
-- Owner order 2026-08-20 (addendum): the owner's phone runs Outlook signed in to
-- Hamilton@axiombiolabs.org, so Tasker can forward the EMAIL codes the same way
-- it forwards texts — via a Notification event instead of a Received Text event.
-- That removes the Microsoft Graph app registration from the critical path
-- entirely: Graph becomes an optional FALLBACK rather than the thing gating 2FA.
--
-- The table keeps its original name (`hamilton_inbound_sms`) on purpose. A
-- rename would break the already-shipped route and any Tasker profile the owner
-- has already keyed in; the `channel` column is what carries the meaning now.
--
-- `subject` exists because portals very often put the one-time code in the
-- SUBJECT LINE ("481920 is your AwardSpring code"), and an Outlook notification
-- surfaces the subject as its title. A reader that only searched the body would
-- miss the most common shape of the thing it exists to find.
--
-- Existing rows are all SMS, and the DEFAULT plus the explicit backfill below
-- make that true rather than assumed.
ALTER TABLE hamilton_inbound_sms ADD COLUMN channel TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE hamilton_inbound_sms ADD COLUMN subject TEXT;
UPDATE hamilton_inbound_sms SET channel = 'sms' WHERE channel IS NULL OR TRIM(channel) = '';
CREATE INDEX IF NOT EXISTS idx_hamilton_inbound_sms_channel_received
  ON hamilton_inbound_sms (channel, received_at DESC);
