-- Add Source Directory persistence (sqlite)
-- Stores user-managed/local-discovered funding sources per organization.

CREATE TABLE IF NOT EXISTS source_directory (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  discovered_for_organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  parent_organization TEXT,
  source_type TEXT,
  website_url TEXT,
  scholarship_page_url TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  crawl_frequency TEXT,
  active INTEGER DEFAULT 1,
  notes TEXT,
  contact_email TEXT,

  last_crawled DATETIME,
  opportunities_found INTEGER DEFAULT 0,
  opportunities_added INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_source_directory_org ON source_directory(discovered_for_organization_id);
CREATE INDEX IF NOT EXISTS idx_source_directory_type ON source_directory(source_type);
CREATE INDEX IF NOT EXISTS idx_source_directory_active ON source_directory(active);

-- Auto-update updated_at on updates
CREATE TRIGGER IF NOT EXISTS update_source_directory_timestamp
AFTER UPDATE ON source_directory
BEGIN
  UPDATE source_directory SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

