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

CREATE TABLE IF NOT EXISTS funding_sources (
  id TEXT PRIMARY KEY,
  state TEXT,
  zip_code TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  amount TEXT,
  deadline TEXT,
  contact_url TEXT,
  source_url TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(state, zip_code, title)
);

CREATE INDEX IF NOT EXISTS idx_funding_sources_state ON funding_sources (state);
CREATE INDEX IF NOT EXISTS idx_funding_sources_updated ON funding_sources (updated_at);
