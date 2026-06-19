-- Hamilton credential vault: optional authenticator-app (TOTP) seed.
--
-- When a portal Hamilton is authorized to log into presents an authenticator-
-- app challenge, she derives the live 6-digit code from this seed (RFC 6238)
-- and types it into the portal's own field — completing sign-in unattended
-- instead of hard-stopping for a human. The seed is encrypted at rest with the
-- same AES-256-GCM envelope as the password (backend/utils/runtimeSecrets.js)
-- and is NEVER returned to any client; list/read responses expose only the
-- boolean has_totp.
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS totp_secret_ciphertext TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS totp_secret_iv TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS totp_secret_tag TEXT;
