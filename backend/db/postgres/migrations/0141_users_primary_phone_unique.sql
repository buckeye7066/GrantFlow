-- Round 22: at most ONE user per phone number. Twin of sqlite migration
-- 137_users_primary_phone_unique.sql. Backstop for the serialized, idempotent
-- first-ever /phone/start (INSERT ... ON CONFLICT (primary_phone) DO NOTHING).

-- De-duplicate first (keep the OLDEST row per phone; null the phone on the rest;
-- non-destructive — no rows/profiles deleted) so the unique index can be created.
UPDATE users AS u
SET primary_phone = NULL
WHERE u.primary_phone IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM users AS older
    WHERE older.primary_phone = u.primary_phone
      AND older.primary_phone IS NOT NULL
      AND (
        older.created_at < u.created_at
        OR (older.created_at = u.created_at AND older.id < u.id)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone
  ON users (primary_phone)
  WHERE primary_phone IS NOT NULL;
