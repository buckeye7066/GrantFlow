-- 127_disable_hamilton_totp_seeds.sql
--
-- Hamilton must not store, derive, type, intercept, or replay live MFA/TOTP
-- codes. Keep the legacy columns for schema compatibility, but erase any seed
-- material written before that policy was enforced.

UPDATE hamilton_portal_credentials
SET
  totp_secret_ciphertext = NULL,
  totp_secret_iv = NULL,
  totp_secret_tag = NULL
WHERE
  totp_secret_ciphertext IS NOT NULL
  OR totp_secret_iv IS NOT NULL
  OR totp_secret_tag IS NOT NULL;
