-- 0178: Postgres twin of backend/db/migrations/173_grant_scoped_ui_entities.sql
-- Real persistence for ChecklistItem / GrantAward / ComplianceReport UI
-- entities that previously wrote to an in-memory client stub.

CREATE TABLE IF NOT EXISTS grant_checklist_items (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  organization_id TEXT,
  title TEXT NOT NULL,
  type TEXT DEFAULT 'task',
  status TEXT DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_grant_checklist_items_grant ON grant_checklist_items(grant_id);

CREATE TABLE IF NOT EXISTS grant_awards (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL UNIQUE REFERENCES grants(id) ON DELETE CASCADE,
  organization_id TEXT,
  award_amount DOUBLE PRECISION,
  funder_name TEXT,
  start_date TEXT,
  end_date TEXT,
  policy_json TEXT,
  reporting_cadence TEXT DEFAULT 'quarterly',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_reports (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  organization_id TEXT,
  report_type TEXT DEFAULT 'quarterly',
  report_period_start TEXT,
  report_period_end TEXT,
  due_date TEXT,
  status TEXT DEFAULT 'scheduled',
  submitted_date TEXT,
  narrative TEXT,
  activities_summary TEXT,
  challenges_faced TEXT,
  next_steps TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_compliance_reports_grant ON compliance_reports(grant_id);
CREATE INDEX IF NOT EXISTS idx_compliance_reports_due ON compliance_reports(due_date);
