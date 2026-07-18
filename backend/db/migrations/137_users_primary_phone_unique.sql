-- Round 22: at most ONE user per phone number (idempotent first-ever /phone/start).
--
-- ensurePhoneCredential creates a user by primary_phone. Two concurrent first-ever
-- /phone/start could each create a user (there was no unique guard on
-- users.primary_phone in either dialect) -> duplicate users/profiles. The route now
-- serializes creation per identifier and uses INSERT ... ON CONFLICT (primary_phone)
-- DO NOTHING; this partial unique index is the DB backstop that makes that possible
-- and rejects a duplicate even if a future caller skips the lock.
--
-- (users.primary_email already has a unique backstop: ux_users_primary_email, added
-- in postgres migration 0005. The email path is kept idempotent via serialized
-- create + that index.)

-- De-duplicate first so the unique index can be created: keep the OLDEST row per
-- phone (smallest id on a created_at tie), null the phone on the rest. Non-
-- destructive: no user rows or profiles are deleted, only a duplicate phone linkage
-- is cleared.
UPDATE users
SET primary_phone = NULL
WHERE primary_phone IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM users older
    WHERE older.primary_phone = users.primary_phone
      AND older.primary_phone IS NOT NULL
      AND (
        older.created_at < users.created_at
        OR (older.created_at = users.created_at AND older.id < users.id)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone
  ON users (primary_phone)
  WHERE primary_phone IS NOT NULL;
