-- Round 21: exactly ONE consumable active OTP code per credential.
-- Twin of sqlite migration 146_one_active_otp_code.sql.
--
-- DB-level backstop for the per-credential serialized mint in
-- insertFreshVerificationCode: on Postgres READ COMMITTED, two concurrent
-- /email/start (or /phone/start) transactions could both run the invalidate
-- before either inserted row was visible and leave TWO active codes. The
-- serialization lock (SELECT ... FOR UPDATE on the credential row) prevents it;
-- this partial unique index guarantees it at the storage layer regardless.
--
-- "Active" = consumed_at IS NULL (no is_active flag). The mint invalidates all
-- consumed_at IS NULL rows before inserting, so the index predicate matches the
-- invalidation predicate and never false-conflicts on expired-but-unconsumed
-- rows (those are invalidated by the mint step).

-- Clean up any pre-existing violation first: keep only the newest active row per
-- credential, consume the rest, so the unique index can be created.
UPDATE user_verification_codes AS uvc
SET consumed_at = CURRENT_TIMESTAMP
WHERE uvc.consumed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM user_verification_codes AS newer
    WHERE newer.credential_id = uvc.credential_id
      AND newer.consumed_at IS NULL
      AND (
        newer.created_at > uvc.created_at
        OR (newer.created_at = uvc.created_at AND newer.id > uvc.id)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_uvc_one_active_per_credential
  ON user_verification_codes (credential_id)
  WHERE consumed_at IS NULL;
