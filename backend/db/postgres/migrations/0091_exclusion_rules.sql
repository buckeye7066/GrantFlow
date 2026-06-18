-- Exclusion Rules (procurement noise suppression).
--
-- This table was previously defined ONLY in backend/db/schema.sql, which is
-- bootstrapped for fresh SQLite dev DBs but is NEVER applied to Postgres (prod).
-- As a result, /api/admin/exclusion-rules and opportunityMatcher Gate 3 failed
-- in production with: relation "exclusion_rules" does not exist.
--
-- See the matching SQLite migration backend/db/migrations/095_exclusion_rules.sql.
CREATE TABLE IF NOT EXISTS exclusion_rules (
  rule_id          TEXT PRIMARY KEY,
  pattern          TEXT,
  action           TEXT,
  confidence_score REAL
);
