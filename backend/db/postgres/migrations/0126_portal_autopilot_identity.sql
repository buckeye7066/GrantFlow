-- Portal Autopilot Identity (Postgres). SQLite parity:
--   backend/db/migrations/125_portal_autopilot_identity.sql
--
-- Lets Hamilton auto-provision logins on portals the owner has NOT signed up to,
-- without the owner managing a password per portal — a password-manager model:
-- ONE master passphrase per profile + a UNIQUE crypto-random password per portal.
--
--   hamilton_portal_master_vault — per-profile master passphrase + autopilot
--     identity email. We store ONLY a random salt + a verifier (scrypt outputs);
--     the passphrase itself is NEVER stored, logged, or returned. The verifier is
--     domain-separated from the wrapping key, so it can confirm a passphrase
--     without ever holding it.
--
--   hamilton_portal_credentials.has_master_wrap / wrapped_* — the wrap columns on
--     auto-provisioned logins. Such a password is encrypted with the scrypt-
--     derived master key (inner layer) AND the existing server vault key (outer
--     layer) — recoverable only with BOTH. password_ciphertext stays NULL on
--     these rows so a leaked server vault key alone never recovers the password.
--
-- Both stores self-heal this schema (ensureMasterVaultSchema / ensureSchema), so
-- the feature works even before this migration runs; ensureSchemaInvariants.js
-- re-asserts it on every boot. This migration keeps prod schema in lockstep.

CREATE TABLE IF NOT EXISTS hamilton_portal_master_vault (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  profile_id TEXT NOT NULL UNIQUE,
  identity_email TEXT,
  kdf TEXT NOT NULL DEFAULT 'scrypt',
  kdf_params TEXT,
  salt TEXT,
  verifier TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hamilton_master_vault_profile ON hamilton_portal_master_vault(profile_id);

-- Wrap columns on the credential vault (idempotent on Postgres).
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS has_master_wrap BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS wrapped_ciphertext TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS wrapped_iv TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS wrapped_tag TEXT;
