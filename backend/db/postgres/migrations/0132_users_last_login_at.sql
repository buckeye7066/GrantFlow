-- Migration 0132: users.last_login_at
--
-- Stamped on every successful sign-in at the createSessionAndTokens choke
-- point; the NULL->set transition fires the one-time "new user just logged in
-- for the first time" owner notification (services/firstLoginNotifier.js).
--
-- The backfill runs ONLY when the column is newly added: every user that
-- exists at introduction time is marked as already signed in (created_at), so
-- long-time users never read as "new" on their next login. Guarding on
-- column-existence (not a bare idempotent UPDATE) matters because a re-run
-- must NOT re-stamp post-introduction users who genuinely haven't signed in
-- yet. Also re-asserted on boot by
-- ensureSchemaInvariants.ensureUsersLastLoginAtColumn with the same
-- backfill-only-on-add semantics.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'last_login_at'
  ) THEN
    ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;
    UPDATE users SET last_login_at = created_at;
  END IF;
END $$;
