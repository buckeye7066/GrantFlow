-- Hamilton credential vault: legacy authenticator-app (TOTP) seed columns.
--
-- Hamilton no longer stores or uses these values. Migration 0128 wipes any
-- legacy seed material while keeping the columns for schema compatibility.
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS totp_secret_ciphertext TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS totp_secret_iv TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS totp_secret_tag TEXT;
