-- Round 21/22/23: at most ONE user per phone number, kept on the CREDENTIAL-OWNED
-- user. Twin of sqlite migration 137_users_primary_phone_unique.sql. Backstop for
-- the serialized, idempotent first-ever /phone/start (INSERT ... ON CONFLICT
-- (primary_phone) DO NOTHING).
--
-- De-dup keeps the phone on the phone_otp credential's user (not merely the oldest)
-- so the credential is never stranded on a nulled-phone user (which would make
-- /phone/verify hit this unique index AFTER consuming the code -> persistent 500s).

-- Step 1: null primary_phone on every user that is NOT the canonical owner of its
-- current phone (canonical = the credential-owned user if present, else oldest).
UPDATE users
SET primary_phone = NULL
WHERE primary_phone IS NOT NULL
  AND id <> COALESCE(
    (SELECT uc.user_id FROM user_credentials uc
     WHERE uc.type = 'phone_otp' AND uc.identifier = users.primary_phone
     LIMIT 1),
    (SELECT u2.id FROM users u2
     WHERE u2.primary_phone = users.primary_phone
     ORDER BY u2.created_at ASC, u2.id ASC
     LIMIT 1)
  );

-- Step 2: restore the phone on a credential-owned user that lost it (earlier
-- age-based de-dup), only when no other user currently holds it.
UPDATE users
SET primary_phone = (
  SELECT uc.identifier FROM user_credentials uc
  WHERE uc.type = 'phone_otp' AND uc.user_id = users.id
  LIMIT 1
)
WHERE primary_phone IS NULL
  AND EXISTS (
    SELECT 1 FROM user_credentials uc2
    WHERE uc2.type = 'phone_otp' AND uc2.user_id = users.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM users u3
    WHERE u3.id <> users.id
      AND u3.primary_phone IS NOT NULL
      AND u3.primary_phone = (
        SELECT uc3.identifier FROM user_credentials uc3
        WHERE uc3.type = 'phone_otp' AND uc3.user_id = users.id
        LIMIT 1
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone
  ON users (primary_phone)
  WHERE primary_phone IS NOT NULL;
