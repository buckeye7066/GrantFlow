-- Apply Engine (submission workflow) tables

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','exported','submitted')),
  submission_method TEXT CHECK(submission_method IN ('portal','email','fax','mail','s2s','download')),
  submitted_at DATETIME,
  exported_at DATETIME,
  portal_url TEXT,
  snapshot_json TEXT,
  artifact_uri TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(grant_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_applications_grant_id ON applications(grant_id);
CREATE INDEX IF NOT EXISTS idx_applications_org_id ON applications(organization_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

CREATE TABLE IF NOT EXISTS application_sections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  title TEXT,
  content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(application_id, section_key)
);

CREATE INDEX IF NOT EXISTS idx_application_sections_application_id ON application_sections(application_id);

CREATE TABLE IF NOT EXISTS application_checklist_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','blocked')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(application_id, key)
);

CREATE INDEX IF NOT EXISTS idx_application_checklist_application_id ON application_checklist_items(application_id);
CREATE INDEX IF NOT EXISTS idx_application_checklist_status ON application_checklist_items(status);

CREATE TABLE IF NOT EXISTS application_artifacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK(format IN ('docx','zip','pdf')),
  storage_path TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_application_artifacts_application_id ON application_artifacts(application_id);

