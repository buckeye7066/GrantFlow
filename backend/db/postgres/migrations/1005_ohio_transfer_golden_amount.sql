-- Postgres twin of backend/db/migrations/1005_ohio_transfer_golden_amount.sql.
-- Persist the owner-verified Ohio University transfer ceiling so the
-- coverage.goldenAmounts sentinel catches future wrong-figure regressions.
CREATE TABLE IF NOT EXISTS system_kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ
);

INSERT INTO system_kv (key, value, updated_at)
VALUES ('golden_amount_expectations', '[]', now())
ON CONFLICT (key) DO NOTHING;

UPDATE system_kv
   SET value = (
         value::jsonb ||
         '[{"label":"Ohio University Transfer Scholarships","url_contains":"ohio.edu/admissions/tuition/transfer-scholarships","expect_max":3000,"over_factor":3,"under_factor":5}]'::jsonb
       )::text,
       updated_at = now()
 WHERE key = 'golden_amount_expectations'
   AND value NOT LIKE '%ohio.edu/admissions/tuition/transfer-scholarships%';
