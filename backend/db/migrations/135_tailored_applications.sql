-- Per-(profile × pipeline grant / portal card) tailored application record.
-- Stores Hamilton's funder-specific, MBA-level, fabrication-guarded narrative
-- (fields_json = section_key → tailored text), its review state, the extracted
-- funder requirements, and any missing questions that block approval/submission.
-- The auto-submit gate reads this as the single choke point before submitting.
CREATE TABLE IF NOT EXISTS tailored_applications (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  grant_id TEXT,
  opportunity_id TEXT,
  fields_json TEXT,
  status TEXT DEFAULT 'pending',
  approved_by TEXT,
  approved_at DATETIME,
  missing_questions_json TEXT,
  funder_requirements_json TEXT,
  generated_from_hash TEXT,
  matcher_version TEXT,
  generator_version TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(profile_id, grant_id)
);
CREATE INDEX IF NOT EXISTS idx_tailored_applications_profile ON tailored_applications(profile_id, grant_id);
