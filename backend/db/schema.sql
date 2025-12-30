PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  profile_type TEXT NOT NULL DEFAULT 'organization',
  display_name TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  full_name TEXT,
  dob TEXT,
  job_title TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  website TEXT,
  mission_statement TEXT,
  ein TEXT,
  duns TEXT,
  cage_code TEXT,
  naics_codes TEXT,
  annual_budget REAL,
  staff_count INTEGER,
  volunteer_count INTEGER,
  service_area TEXT,
  demographics_served TEXT,
  program_focus_areas TEXT,
  compliance_notes TEXT,
  certifications TEXT,
  phi_access_required INTEGER DEFAULT 0,
  created_by TEXT,
  owner_id TEXT,
  case_manager_id TEXT,
  admin_id TEXT,
  last_contacted_at TEXT,
  application_data TEXT,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'unknown',
  extracted_json TEXT,
  suggested_patches_json TEXT,
  applied_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_documents_profile ON documents (profile_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);

CREATE TABLE IF NOT EXISTS discovery_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  region TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  schedule TEXT,
  last_run_at TEXT,
  last_success_at TEXT,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS funding_sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  description TEXT DEFAULT '',
  amount_min REAL,
  amount_max REAL,
  currency TEXT DEFAULT 'USD',
  deadline TEXT,
  geography TEXT,
  category TEXT,
  tags TEXT,
  eligibility TEXT,
  source_id TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  source_url TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES discovery_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS discovery_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  query TEXT,
  filters_json TEXT,
  owner_id TEXT,
  is_default INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_saved_searches (
  id TEXT PRIMARY KEY,
  template_id TEXT,
  profile_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  filters_json TEXT,
  schedule TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(template_id) REFERENCES discovery_templates(id),
  FOREIGN KEY(profile_id) REFERENCES profiles(id)
);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id TEXT PRIMARY KEY,
  template_id TEXT,
  profile_id TEXT,
  query TEXT,
  filters_json TEXT,
  executed_by TEXT,
  result_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(template_id) REFERENCES discovery_templates(id),
  FOREIGN KEY(profile_id) REFERENCES profiles(id)
);

CREATE TABLE IF NOT EXISTS discovery_activity_log (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  type TEXT NOT NULL,
  message TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES discovery_sources(id)
);

CREATE INDEX IF NOT EXISTS idx_funding_sources_category ON funding_sources (category);
CREATE INDEX IF NOT EXISTS idx_funding_sources_region ON funding_sources (geography);
CREATE INDEX IF NOT EXISTS idx_funding_sources_updated ON funding_sources (updated_at);
