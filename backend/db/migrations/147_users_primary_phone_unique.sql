-- Round 21/22/23: at most ONE user per phone number (idempotent first-ever
-- /phone/start), with the phone kept on the CREDENTIAL-OWNED user.
--
-- ensurePhoneCredential creates a user by primary_phone. Two concurrent first-ever
-- /phone/start could each create a user (there was no unique guard on
-- users.primary_phone) -> duplicate users. The route now serializes creation and
-- uses INSERT ... ON CONFLICT (primary_phone) DO NOTHING; this partial unique index
-- is the DB backstop.
--
-- De-dup MUST keep the phone on the user that the phone_otp CREDENTIAL points at —
-- NOT merely the oldest row. Otherwise (round 22 bug) the credential could be left
-- pointing at a user whose primary_phone got nulled; /phone/verify would then try to
-- set the phone back on that user and hit this unique index — AFTER consuming the
-- code — giving the user PERSISTENT 500s on a correct code.

-- Round 26: CAPTURE the dup->canonical identity into a DURABLE table BEFORE Step 1
-- nulls the duplicates' primary_phone. The forward repair migration (148/0152)
-- identifies duplicates by phone; if the phone were already nulled its repair would
-- be a silent no-op (Codex r26 #1). The map survives; 148 consumes it.
CREATE TABLE IF NOT EXISTS phone_dedupe_map (
  dup_user_id TEXT NOT NULL,
  canonical_user_id TEXT NOT NULL,
  phone TEXT,
  PRIMARY KEY (dup_user_id, canonical_user_id)
);
INSERT INTO phone_dedupe_map (dup_user_id, canonical_user_id, phone)
SELECT d.id, uc.user_id, d.primary_phone
FROM users d
JOIN user_credentials uc ON uc.type = 'phone_otp' AND uc.identifier = d.primary_phone
WHERE d.primary_phone IS NOT NULL AND uc.user_id <> d.id
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

-- Step 1: null primary_phone on every user that is NOT the canonical owner of its
-- current phone. Canonical = the phone_otp credential's user for that phone if one
-- exists (credential-owned), else the oldest user with the phone. Non-destructive:
-- only a duplicate phone linkage is cleared; no user rows or profiles are deleted.
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

-- Step 2: if a credential-owned user lost its phone (e.g. an earlier age-based
-- de-dup run nulled it), restore the phone on THAT user — but only when no other
-- user currently holds it (so we never create a new duplicate). This guarantees the
-- credential-owned user keeps the phone, so /phone/verify never re-conflicts.
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
