-- PostgreSQL parity for SQLite migration 036_match_decision_metadata.sql.
-- Crawler OS persistence schema-introspects these fields and otherwise has to
-- drop structured applicant, need, and deadline semantics in production.

-- Canonical per-profile decision metadata. Earlier Postgres repair migrations
-- added some of migration 036's grant fields, but these four were still absent
-- from a clean replay and from already-stamped production databases.
ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS eligibility_status TEXT;
ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS ineligibility_reasons TEXT DEFAULT '[]';
ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ;
ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS match_confidence INTEGER;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS entity_types_allowed TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS need_types_supported TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS deadline_status TEXT;
ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS official_source_type TEXT;
ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS source_trust_score INTEGER;
ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS opportunity_fingerprint TEXT;

-- Cached normalization inputs used to detect stale profile decisions.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS profile_fingerprint TEXT;
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS normalized_snapshot TEXT;
