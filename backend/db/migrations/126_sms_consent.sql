-- @sqlite-continue-on-idempotent-errors
-- SMS consent lifecycle (SQLite). Postgres parity:
--   backend/db/postgres/migrations/0127_sms_consent.sql
--
-- Adds the per-phone consent state machine on top of profile_phones (owned by
-- backend/services/comms/commsService.js; state machine in
-- backend/services/comms/smsConsentService.js). Owner requirement: text every
-- profile asking if SMS is OK — YES turns it on, NO/STOP/no-response leaves it
-- off. TCPA-conservative: the default for an un-consented number is OFF.
--
--   consent_status        none | pending | opted_in | opted_out
--                         (default 'none' — no consent asked yet, stays OFF)
--   consent_requested_at  when the consent SMS was sent (drives expiry sweep)
--
-- sms_opt_in remains the single effective boolean every send path reads; it is
-- TRUE only when consent_status = 'opted_in'.
--
-- ensureCommsSchema + ensureSchemaInvariants.js re-assert these columns on every
-- boot, so the feature works even before this migration runs; this keeps prod
-- schema in lockstep.

-- profile_phones is normally created at runtime by ensureCommsSchema
-- (backend/services/comms/commsService.js). A fresh SQL-only migration chain
-- never runs that JS, so create it here too — idempotent (no-op once it exists).
CREATE TABLE IF NOT EXISTS profile_phones (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  label TEXT,
  sms_opt_in BOOLEAN DEFAULT 1,
  added_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_profile_phones_profile ON profile_phones(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_phones_profile_phone ON profile_phones(profile_id, phone);

ALTER TABLE profile_phones ADD COLUMN consent_status TEXT DEFAULT 'none';
ALTER TABLE profile_phones ADD COLUMN consent_requested_at TIMESTAMP;

-- Backfill: rows explicitly admin-opted-in before consent tracking existed are
-- treated as opted_in; everything else with no status becomes 'none' (OFF).
UPDATE profile_phones SET consent_status = 'opted_in'
  WHERE (consent_status IS NULL OR consent_status = '') AND sms_opt_in = 1;
UPDATE profile_phones SET consent_status = 'none'
  WHERE consent_status IS NULL OR consent_status = '';

CREATE INDEX IF NOT EXISTS idx_profile_phones_consent_status ON profile_phones(consent_status);
