-- Round 21: exactly ONE consumable active OTP code per credential.
--
-- /email/start and /phone/start mint via insertFreshVerificationCode, which
-- invalidates prior active codes + inserts the fresh one under a per-credential
-- serialization lock. This partial unique index is the DB-level BACKSTOP: the
-- database itself rejects a second active (consumed_at IS NULL) code for a
-- credential even if a future caller forgets the lock (a concurrent-/start race
-- on Postgres READ COMMITTED that would otherwise leave two active rows).
--
-- "Active" is modeled as consumed_at IS NULL (there is no is_active flag).
-- insertFreshVerificationCode invalidates ALL consumed_at IS NULL rows (expired
-- included) before inserting, so the index predicate matches the invalidation
-- predicate exactly and never false-conflicts on legitimately-expired rows.

-- First clean up any pre-existing violation so the unique index can be created:
-- keep only the newest active row per credential, consume the rest.
UPDATE user_verification_codes
SET consumed_at = CURRENT_TIMESTAMP
WHERE consumed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM user_verification_codes newer
    WHERE newer.credential_id = user_verification_codes.credential_id
      AND newer.consumed_at IS NULL
      AND (
        newer.created_at > user_verification_codes.created_at
        OR (newer.created_at = user_verification_codes.created_at AND newer.id > user_verification_codes.id)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_uvc_one_active_per_credential
  ON user_verification_codes (credential_id)
  WHERE consumed_at IS NULL;
