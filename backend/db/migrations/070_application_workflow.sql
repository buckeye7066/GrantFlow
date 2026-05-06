-- Phase 7: Discovery → Action workflow
--
-- Mission rule: every discovered opportunity must be able to become a saved
-- item, an application plan, a document checklist, a deadline tracker, and
-- an Anya-guided workflow. We extend the existing grant_applications table
-- (migration 047) with the missing entities so the full workflow has a
-- durable home:
--
--   profile_opportunity_matches  immutable record of why an opp matched a
--                                profile at a point in time (audit trail
--                                separate from the saved grants pipeline)
--   application_steps            checklist items for one application
--   application_documents        attachment metadata
--   deadline_events              deadline reminders + completion events
--   submission_events            portal-started/submitted/awarded outcomes
--
-- All FKs cascade on profile/application delete so closing a profile or
-- application cleans up its workflow without orphaned rows.

CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  match_score REAL,
  match_decision TEXT,
  match_confidence REAL,
  matched_profile_facts TEXT,
  ineligibility_reasons TEXT,
  matcher_version TEXT,
  evaluated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pom_profile_id ON profile_opportunity_matches(profile_id);
CREATE INDEX IF NOT EXISTS idx_pom_opportunity_id ON profile_opportunity_matches(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_pom_evaluated_at ON profile_opportunity_matches(evaluated_at);

CREATE TABLE IF NOT EXISTS application_steps (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  step_order INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  due_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES grant_applications(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_application_steps_app ON application_steps(application_id);
CREATE INDEX IF NOT EXISTS idx_application_steps_status ON application_steps(status);

CREATE TABLE IF NOT EXISTS application_documents (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  step_id TEXT,
  filename TEXT NOT NULL,
  document_type TEXT,
  storage_url TEXT,
  size_bytes INTEGER,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  uploaded_by TEXT,
  FOREIGN KEY (application_id) REFERENCES grant_applications(id) ON DELETE CASCADE,
  FOREIGN KEY (step_id) REFERENCES application_steps(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_application_documents_app ON application_documents(application_id);
CREATE INDEX IF NOT EXISTS idx_application_documents_step ON application_documents(step_id);

CREATE TABLE IF NOT EXISTS deadline_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'reminder',
  due_at TIMESTAMP NOT NULL,
  fired_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES grant_applications(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_deadline_events_app ON deadline_events(application_id);
CREATE INDEX IF NOT EXISTS idx_deadline_events_due ON deadline_events(due_at);

CREATE TABLE IF NOT EXISTS submission_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  outcome TEXT,
  recorded_by TEXT,
  FOREIGN KEY (application_id) REFERENCES grant_applications(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_submission_events_app ON submission_events(application_id);
CREATE INDEX IF NOT EXISTS idx_submission_events_type ON submission_events(event_type);
CREATE INDEX IF NOT EXISTS idx_submission_events_occurred ON submission_events(occurred_at);
