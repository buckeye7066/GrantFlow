-- Enforce one profile per owning user (email identity is unique via user_credentials).
-- This intentionally allows legacy profiles with NULL user_id.
--
-- Self-healing migration:
-- If duplicates exist (multiple profiles with the same non-null user_id), deterministically pick a winner
-- and merge losers into it:
-- - winner: oldest created_at (NULLS LAST), tie-breaker by id
-- - repoint ALL FK references from loser profiles -> winner profile
-- - handle conflicts safely in:
--   - profile_sections (UNIQUE(profile_id, section_key)): keep winner row, drop loser conflicts
--   - profile_documents (PK(profile_id, document_id)): keep winner row, drop loser conflicts
-- - delete loser profiles
-- Then create the unique index.

BEGIN;

-- 1) Compute loser->winner mapping (temp, transaction-scoped).
CREATE TEMP TABLE profile_merge_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    user_id,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn,
    FIRST_VALUE(id) OVER (
      PARTITION BY user_id
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS winner_id
  FROM profiles
  WHERE user_id IS NOT NULL
)
SELECT
  id AS loser_id,
  winner_id,
  user_id
FROM ranked
WHERE rn > 1;

-- If no duplicates, proceed to index creation.
-- (Keep the rest of the statements safe/idempotent anyway.)

-- 2) Pre-delete conflicts for profile_sections unique(profile_id, section_key).
DELETE FROM profile_sections ps
USING profile_merge_map m
JOIN profile_sections keep
  ON keep.profile_id = m.winner_id
 AND keep.section_key = ps.section_key
WHERE ps.profile_id = m.loser_id;

-- 3) Repoint profile_sections to winner.
UPDATE profile_sections ps
SET profile_id = m.winner_id
FROM profile_merge_map m
WHERE ps.profile_id = m.loser_id;

-- 4) Pre-delete conflicts for profile_documents PK(profile_id, document_id).
DELETE FROM profile_documents pd
USING profile_merge_map m
JOIN profile_documents keep
  ON keep.profile_id = m.winner_id
 AND keep.document_id = pd.document_id
WHERE pd.profile_id = m.loser_id;

-- 5) Repoint profile_documents to winner.
UPDATE profile_documents pd
SET profile_id = m.winner_id
FROM profile_merge_map m
WHERE pd.profile_id = m.loser_id;

-- 6) Repoint all other FK references to profiles(id) dynamically.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      a.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN LATERAL unnest(con.conkey) AS colnum(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = colnum.attnum
    WHERE con.contype = 'f'
      AND con.confrelid = 'profiles'::regclass
      AND n.nspname = 'public'
      AND c.relname NOT IN ('profile_sections', 'profile_documents')
  LOOP
    EXECUTE format(
      'UPDATE %I.%I t SET %I = m.winner_id FROM profile_merge_map m WHERE t.%I = m.loser_id',
      r.schema_name, r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END $$;

-- 7) Delete loser profiles after repointing.
DELETE FROM profiles p
USING profile_merge_map m
WHERE p.id = m.loser_id;

-- 8) Assert no remaining duplicates (evidence query).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM profiles
    WHERE user_id IS NOT NULL
    GROUP BY user_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'profiles.user_id still has duplicates; cannot create ux_profiles_user_id';
  END IF;
END $$;

-- 9) Enforce uniqueness (allows legacy profiles with NULL user_id).
CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_user_id
  ON profiles (user_id)
  WHERE user_id IS NOT NULL;

COMMIT;

