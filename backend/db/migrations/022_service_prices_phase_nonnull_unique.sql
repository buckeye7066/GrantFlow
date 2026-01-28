-- Ensure service_prices seeding is truly idempotent by preventing multiple NULL milestone_phase rows.
--
-- SQLite UNIQUE constraints treat NULL as distinct, so the original UNIQUE(service_id, client_category, currency, milestone_phase)
-- allowed duplicates when milestone_phase IS NULL. We:
-- 1) delete duplicate NULL-phase rows (keep one),
-- 2) normalize NULL -> '' (empty string) for non-milestone rows,
-- 3) add a UNIQUE index on the normalized key (COALESCE).

-- 1) Delete duplicates for NULL milestone_phase (keep the lexicographically smallest id per key).
-- Also drop any NULL-phase rows that would collide with an existing ''-phase row once normalized.
DELETE FROM service_prices
WHERE milestone_phase IS NULL
  AND EXISTS (
    SELECT 1
    FROM service_prices sp2
    WHERE sp2.service_id = service_prices.service_id
      AND sp2.client_category = service_prices.client_category
      AND sp2.currency = service_prices.currency
      AND COALESCE(sp2.milestone_phase, '') = ''
  );

-- After removing collisions, dedupe remaining NULL rows within NULL-only keys (keep one).
DELETE FROM service_prices
WHERE milestone_phase IS NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM service_prices
    WHERE milestone_phase IS NULL
    GROUP BY service_id, client_category, currency
  );

-- 2) Normalize NULL -> '' so future uniqueness checks work.
UPDATE service_prices
SET milestone_phase = ''
WHERE milestone_phase IS NULL;

-- 3) Enforce uniqueness even if some writer attempts NULL in the future.
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_prices_unique_norm_phase
ON service_prices(service_id, client_category, currency, COALESCE(milestone_phase, ''));

