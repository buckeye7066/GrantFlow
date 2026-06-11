-- Phase 7: Discovery -> Action workflow (Postgres mirror of SQLite migration 070)

-- grant_applications is created by SQLite migration 047 but was never ported to
-- Postgres, so the FK references below (application_id -> grant_applications)
-- failed on a fresh Postgres replay with "relation grant_applications does not
-- exist". Create it here (idempotent) — a no-op where it already exists.
CREATE TABLE IF NOT EXISTS grant_applications (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT,
  pipeline_grant_id TEXT,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT,
  grant_name TEXT NOT NULL,
  funder_name TEXT,
  amount_requested DOUBLE PRECISION,
  amount_awarded DOUBLE PRECISION,
  deadline_date TEXT,
  submitted_at TIMESTAMPTZ,
  response_expected_date TEXT,
  response_received_at TIMESTAMPTZ,
  notes TEXT,
  contact_name TEXT,
  contact_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_grant_applications_user_id ON grant_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_grant_applications_profile_id ON grant_applications(profile_id);
CREATE INDEX IF NOT EXISTS idx_grant_applications_status ON grant_applications(status);

CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL,
  match_score DOUBLE PRECISION,
  match_decision TEXT,
  match_confidence DOUBLE PRECISION,
  matched_profile_facts TEXT,
  ineligibility_reasons TEXT,
  matcher_version TEXT,
  evaluated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pom_profile_id ON profile_opportunity_matches(profile_id);
CREATE INDEX IF NOT EXISTS idx_pom_opportunity_id ON profile_opportunity_matches(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_pom_evaluated_at ON profile_opportunity_matches(evaluated_at);

CREATE TABLE IF NOT EXISTS application_steps (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES grant_applications(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_application_steps_app ON application_steps(application_id);
CREATE INDEX IF NOT EXISTS idx_application_steps_status ON application_steps(status);

CREATE TABLE IF NOT EXISTS application_documents (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES grant_applications(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES application_steps(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  document_type TEXT,
  storage_url TEXT,
  size_bytes BIGINT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  uploaded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_application_documents_app ON application_documents(application_id);
CREATE INDEX IF NOT EXISTS idx_application_documents_step ON application_documents(step_id);

CREATE TABLE IF NOT EXISTS deadline_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES grant_applications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL DEFAULT 'reminder',
  due_at TIMESTAMPTZ NOT NULL,
  fired_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deadline_events_app ON deadline_events(application_id);
CREATE INDEX IF NOT EXISTS idx_deadline_events_due ON deadline_events(due_at);

CREATE TABLE IF NOT EXISTS submission_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES grant_applications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  outcome TEXT,
  recorded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_submission_events_app ON submission_events(application_id);
CREATE INDEX IF NOT EXISTS idx_submission_events_type ON submission_events(event_type);
CREATE INDEX IF NOT EXISTS idx_submission_events_occurred ON submission_events(occurred_at);
