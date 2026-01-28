-- Ensure service_prices seeding is truly idempotent by preventing multiple NULL milestone_phase rows.
--
-- Postgres UNIQUE constraints treat NULL as distinct too, so duplicates were possible for milestone_phase IS NULL.
-- We:
-- 1) delete duplicate NULL-phase rows (keep one),
-- 2) normalize NULL -> '' (empty string),
-- 3) enforce NOT NULL + default '' so future inserts can't reintroduce NULL.

-- 1) Delete duplicates for NULL milestone_phase (keep earliest created_at, then smallest id).
-- Also drop any NULL-phase rows that would collide with an existing ''-phase row once normalized.
DELETE FROM service_prices sp
WHERE sp.milestone_phase IS NULL
  AND EXISTS (
    SELECT 1
    FROM service_prices sp2
    WHERE sp2.service_id = sp.service_id
      AND sp2.client_category = sp.client_category
      AND sp2.currency = sp.currency
      AND COALESCE(sp2.milestone_phase, '') = ''
  );

-- After removing collisions, dedupe remaining NULL rows within NULL-only keys (keep one).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY service_id, client_category, currency
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM service_prices
  WHERE milestone_phase IS NULL
)
DELETE FROM service_prices
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2) Normalize NULL -> '' so the existing UNIQUE(service_id, client_category, currency, milestone_phase) applies.
UPDATE service_prices
SET milestone_phase = ''
WHERE milestone_phase IS NULL;

-- 3) Prevent future NULLs.
ALTER TABLE service_prices
  ALTER COLUMN milestone_phase SET DEFAULT '';

ALTER TABLE service_prices
  ALTER COLUMN milestone_phase SET NOT NULL;

