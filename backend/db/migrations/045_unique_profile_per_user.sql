-- Enforce one profile per owning user (email identity is unique via user_credentials).
-- This intentionally allows legacy profiles with NULL user_id.
--
-- NOTE: This will fail if duplicates already exist. Use the Admin bulk dedupe tool
-- (email/phone strategy) to merge duplicates before applying this constraint.

CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_user_id
  ON profiles(user_id)
  WHERE user_id IS NOT NULL;

