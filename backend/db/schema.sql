PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  profile_type TEXT NOT NULL DEFAULT 'organization', -- organization | individual
  display_name TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- canonical identity fields (for IDs, licenses, etc.)
  full_name TEXT,
  dob TEXT, -- ISO date: YYYY-MM-DD

  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL, -- uploaded | parsing | parsed | applied | failed
  doc_type TEXT NOT NULL DEFAULT 'unknown',
  extracted_json TEXT,         -- raw extraction + structured fields
  suggested_patches_json TEXT, -- patch plan for profile/funding_sources
  applied_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_documents_profile ON documents(profile_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
