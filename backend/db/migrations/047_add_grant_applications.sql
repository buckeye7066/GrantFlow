-- Grant application tracking workflow
-- Tracks each grant from "found" through "applying" → "submitted" → "awarded/denied"

CREATE TABLE IF NOT EXISTS grant_applications (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  opportunity_id TEXT,
  pipeline_grant_id TEXT,
  user_id TEXT NOT NULL,

  -- Application status lifecycle
  -- Valid statuses: draft, in_progress, submitted, under_review, awarded, denied, withdrawn
  status TEXT NOT NULL DEFAULT 'draft',

  -- Application details
  title TEXT,
  grant_name TEXT NOT NULL,
  funder_name TEXT,
  amount_requested REAL,
  amount_awarded REAL,

  -- Dates
  deadline_date TEXT,
  submitted_at TIMESTAMP,
  response_expected_date TEXT,
  response_received_at TIMESTAMP,

  -- Notes and contact
  notes TEXT,
  contact_name TEXT,
  contact_email TEXT,

  -- Audit
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_grant_applications_user_id ON grant_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_grant_applications_profile_id ON grant_applications(profile_id);
CREATE INDEX IF NOT EXISTS idx_grant_applications_status ON grant_applications(status);
