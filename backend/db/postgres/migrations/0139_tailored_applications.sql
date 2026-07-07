-- Per-(profile × pipeline grant / portal card) tailored application record (Postgres).
-- Mirrors backend/db/migrations/135_tailored_applications.sql. Idempotent.
CREATE TABLE IF NOT EXISTS tailored_applications (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  grant_id TEXT,
  opportunity_id TEXT,
  fields_json TEXT,
  status TEXT DEFAULT 'pending',
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  missing_questions_json TEXT,
  funder_requirements_json TEXT,
  generated_from_hash TEXT,
  matcher_version TEXT,
  generator_version TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(profile_id, grant_id)
);
CREATE INDEX IF NOT EXISTS idx_tailored_applications_profile ON tailored_applications(profile_id, grant_id);
