-- Postgres twin of SQLite migration 162. This forward migration reaches
-- already-stamped databases; the matching change in migration 0123 keeps a
-- fresh canonical migration independently complete.

ALTER TABLE profile_opportunity_matches
  ADD COLUMN IF NOT EXISTS match_confidence DOUBLE PRECISION;
