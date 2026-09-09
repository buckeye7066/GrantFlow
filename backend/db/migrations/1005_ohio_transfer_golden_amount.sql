-- Persist the owner-verified Ohio University transfer ceiling so the
-- coverage.goldenAmounts sentinel catches future wrong-figure regressions.
CREATE TABLE IF NOT EXISTS system_kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

INSERT OR IGNORE INTO system_kv (key, value, updated_at)
VALUES ('golden_amount_expectations', '[]', CURRENT_TIMESTAMP);

UPDATE system_kv
   SET value = json_insert(
                 value,
                 '$[#]',
                 json('{"label":"Ohio University Transfer Scholarships","url_contains":"ohio.edu/admissions/tuition/transfer-scholarships","expect_max":3000,"over_factor":3,"under_factor":5}')
               ),
       updated_at = CURRENT_TIMESTAMP
 WHERE key = 'golden_amount_expectations'
   AND value NOT LIKE '%ohio.edu/admissions/tuition/transfer-scholarships%';
