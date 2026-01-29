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
--   - billing_accounts (UNIQUE(profile_id) via idx_billing_accounts_profile): keep one billing_account per user, repoint events
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

-- 2) Resolve profile_sections conflicts safely.
-- Conflicts can occur not only between winner vs loser, but also between multiple losers that share the same section_key.
-- We deterministically keep ONE row per (winner_id, section_key):
--   - prefer an existing winner row if present
--   - otherwise keep the oldest created_at (NULLS LAST), tie-breaker smallest id
CREATE TEMP TABLE profile_sections_repoint ON COMMIT DROP AS
WITH impacted_profiles AS (
  SELECT loser_id AS profile_id FROM profile_merge_map
  UNION
  SELECT winner_id AS profile_id FROM profile_merge_map
),
rows AS (
  SELECT
    ps.id,
    ps.profile_id AS source_profile_id,
    COALESCE(m.winner_id, ps.profile_id) AS target_profile_id,
    ps.section_key,
    ps.created_at,
    (ps.profile_id = COALESCE(m.winner_id, ps.profile_id)) AS is_winner_row
  FROM profile_sections ps
  JOIN impacted_profiles ip ON ip.profile_id = ps.profile_id
  LEFT JOIN profile_merge_map m ON m.loser_id = ps.profile_id
),
ranked AS (
  SELECT
    id,
    source_profile_id,
    target_profile_id,
    section_key,
    ROW_NUMBER() OVER (
      PARTITION BY target_profile_id, section_key
      ORDER BY is_winner_row DESC, created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM rows
)
SELECT * FROM ranked;

-- Delete any rows that would become duplicates after repointing.
DELETE FROM profile_sections ps
USING profile_sections_repoint r
WHERE ps.id = r.id
  AND r.rn > 1;

-- Repoint remaining rows to the winner.
UPDATE profile_sections ps
SET profile_id = r.target_profile_id
FROM profile_sections_repoint r
WHERE ps.id = r.id
  AND ps.profile_id <> r.target_profile_id;

-- 3) Resolve profile_documents conflicts safely.
-- Conflicts can occur between winner vs loser OR between multiple losers that reference the same document_id.
-- Deterministically keep ONE row per (winner_id, document_id):
--   - prefer an existing winner row if present
--   - otherwise keep the smallest source profile_id (stable tie-breaker; profile_documents has no timestamps)
CREATE TEMP TABLE profile_documents_map ON COMMIT DROP AS
WITH impacted_profiles AS (
  SELECT loser_id AS profile_id FROM profile_merge_map
  UNION
  SELECT winner_id AS profile_id FROM profile_merge_map
)
SELECT
  pd.profile_id AS source_profile_id,
  pd.document_id,
  COALESCE(m.winner_id, pd.profile_id) AS target_profile_id,
  (pd.profile_id = COALESCE(m.winner_id, pd.profile_id)) AS is_winner_row
FROM profile_documents pd
JOIN impacted_profiles ip ON ip.profile_id = pd.profile_id
LEFT JOIN profile_merge_map m ON m.loser_id = pd.profile_id;

CREATE TEMP TABLE profile_documents_keep ON COMMIT DROP AS
SELECT
  target_profile_id,
  document_id,
  COALESCE(
    MAX(CASE WHEN is_winner_row THEN source_profile_id END),
    MIN(source_profile_id)
  ) AS keep_source_profile_id
FROM profile_documents_map
GROUP BY target_profile_id, document_id;

-- Delete any rows that would become duplicates after repointing.
DELETE FROM profile_documents pd
USING profile_documents_map m
JOIN profile_documents_keep k
  ON k.target_profile_id = m.target_profile_id
 AND k.document_id = m.document_id
WHERE pd.profile_id = m.source_profile_id
  AND pd.document_id = m.document_id
  AND m.source_profile_id <> k.keep_source_profile_id;

-- Repoint remaining rows to the winner.
UPDATE profile_documents pd
SET profile_id = m.target_profile_id
FROM profile_documents_map m
WHERE pd.profile_id = m.source_profile_id
  AND pd.document_id = m.document_id
  AND pd.profile_id <> m.target_profile_id;

-- 4) Resolve billing_accounts uniqueness (idx_billing_accounts_profile) safely.
-- Choose ONE billing_account per user (oldest created_at; tie-breaker smallest id),
-- repoint all billing_account_events to that account, delete the rest, then ensure the kept
-- billing_account is attached to the winning profile.
CREATE TEMP TABLE billing_account_chosen ON COMMIT DROP AS
WITH impacted_users AS (
  SELECT DISTINCT user_id, winner_id
  FROM profile_merge_map
),
accounts AS (
  SELECT
    ba.id AS account_id,
    ba.created_at,
    p.user_id,
    u.winner_id AS winner_profile_id
  FROM billing_accounts ba
  JOIN profiles p
    ON p.id = ba.profile_id
  JOIN impacted_users u
    ON u.user_id = p.user_id
),
ranked AS (
  SELECT
    account_id,
    user_id,
    winner_profile_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY created_at ASC NULLS LAST, account_id ASC
    ) AS rn,
    FIRST_VALUE(account_id) OVER (
      PARTITION BY user_id
      ORDER BY created_at ASC NULLS LAST, account_id ASC
    ) AS keep_account_id
  FROM accounts
)
SELECT DISTINCT
  user_id,
  winner_profile_id,
  keep_account_id
FROM ranked;

CREATE TEMP TABLE billing_account_merge_map ON COMMIT DROP AS
WITH impacted_users AS (
  SELECT DISTINCT user_id
  FROM profile_merge_map
),
accounts AS (
  SELECT
    ba.id AS account_id,
    p.user_id
  FROM billing_accounts ba
  JOIN profiles p
    ON p.id = ba.profile_id
  JOIN impacted_users u
    ON u.user_id = p.user_id
)
SELECT
  a.account_id,
  c.keep_account_id
FROM accounts a
JOIN billing_account_chosen c
  ON c.user_id = a.user_id
WHERE a.account_id <> c.keep_account_id;

-- Repoint billing_account_events away from accounts we will delete (preserves history).
DO $$
BEGIN
  IF to_regclass('public.billing_account_events') IS NOT NULL THEN
    UPDATE billing_account_events e
    SET account_id = m.keep_account_id
    FROM billing_account_merge_map m
    WHERE e.account_id = m.account_id;
  END IF;
END $$;

-- Delete extra billing accounts (prevents unique(profile_id) violation during profile repoint).
DELETE FROM billing_accounts ba
USING billing_account_merge_map m
WHERE ba.id = m.account_id;

-- Ensure the kept billing account is attached to the winning profile.
UPDATE billing_accounts ba
SET profile_id = c.winner_profile_id
FROM billing_account_chosen c
WHERE ba.id = c.keep_account_id
  AND ba.profile_id <> c.winner_profile_id;

-- 4b) Resolve profile_emails uniqueness (ux_profile_emails_profile_email) safely.
-- This table may have been created at runtime (ensureProfileEmailSchema) rather than by migrations,
-- so guard the cleanup in case it doesn't exist in older environments.
DO $$
BEGIN
  IF to_regclass('public.profile_emails') IS NOT NULL THEN
    EXECUTE $SQL$
      CREATE TEMP TABLE profile_emails_repoint ON COMMIT DROP AS
      WITH impacted_profiles AS (
        SELECT loser_id AS profile_id FROM profile_merge_map
        UNION
        SELECT winner_id AS profile_id FROM profile_merge_map
      ),
      rows AS (
        SELECT
          pe.id,
          pe.profile_id AS source_profile_id,
          COALESCE(m.winner_id, pe.profile_id) AS target_profile_id,
          LOWER(pe.email) AS email_norm,
          pe.created_at,
          (pe.profile_id = COALESCE(m.winner_id, pe.profile_id)) AS is_winner_row
        FROM profile_emails pe
        JOIN impacted_profiles ip ON ip.profile_id = pe.profile_id
        LEFT JOIN profile_merge_map m ON m.loser_id = pe.profile_id
      ),
      ranked AS (
        SELECT
          id,
          source_profile_id,
          target_profile_id,
          email_norm,
          ROW_NUMBER() OVER (
            PARTITION BY target_profile_id, email_norm
            ORDER BY is_winner_row DESC, created_at ASC NULLS LAST, id ASC
          ) AS rn
        FROM rows
      )
      SELECT * FROM ranked;

      -- Delete any rows that would become duplicates after repointing.
      DELETE FROM profile_emails pe
      USING profile_emails_repoint r
      WHERE pe.id = r.id
        AND r.rn > 1;

      -- Repoint remaining rows to the winner.
      UPDATE profile_emails pe
      SET profile_id = r.target_profile_id
      FROM profile_emails_repoint r
      WHERE pe.id = r.id
        AND pe.profile_id <> r.target_profile_id;
    $SQL$;
  END IF;
END $$;

-- 5) Repoint all other FK references to profiles(id) dynamically.
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
      AND c.relname NOT IN ('profile_sections', 'profile_documents', 'billing_accounts', 'profile_emails')
  LOOP
    EXECUTE format(
      'UPDATE %I.%I t SET %I = m.winner_id FROM profile_merge_map m WHERE t.%I = m.loser_id',
      r.schema_name, r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END $$;

-- 6) Delete loser profiles after repointing.
DELETE FROM profiles p
USING profile_merge_map m
WHERE p.id = m.loser_id;

-- 7) Assert no remaining duplicates (evidence query).
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

-- 8) Enforce uniqueness (allows legacy profiles with NULL user_id).
CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_user_id
  ON profiles (user_id)
  WHERE user_id IS NOT NULL;

COMMIT;
