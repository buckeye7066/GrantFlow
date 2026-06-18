-- Exclusion Rules (procurement noise suppression).
--
-- Present in backend/db/schema.sql for fresh DBs, but absent from older SQLite
-- dev DBs that were bootstrapped before this table was added to schema.sql.
-- Create it idempotently so existing local databases self-heal on next migrate.
-- Mirrors backend/db/postgres/migrations/0091_exclusion_rules.sql.
CREATE TABLE IF NOT EXISTS exclusion_rules (
  rule_id          TEXT PRIMARY KEY,
  pattern          TEXT,
  action           TEXT,
  confidence_score REAL
);
