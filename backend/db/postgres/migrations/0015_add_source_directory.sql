-- Add Source Directory persistence (postgres)

CREATE TABLE IF NOT EXISTS source_directory (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

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
  active BOOLEAN DEFAULT TRUE,
  notes TEXT,
  contact_email TEXT,

  last_crawled TIMESTAMPTZ,
  opportunities_found INTEGER DEFAULT 0,
  opportunities_added INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_source_directory_org ON source_directory(discovered_for_organization_id);
CREATE INDEX IF NOT EXISTS idx_source_directory_type ON source_directory(source_type);
CREATE INDEX IF NOT EXISTS idx_source_directory_active ON source_directory(active);

-- Keep updated_at fresh
CREATE OR REPLACE FUNCTION set_source_directory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_source_directory_updated_at ON source_directory;
CREATE TRIGGER trg_source_directory_updated_at
BEFORE UPDATE ON source_directory
FOR EACH ROW
EXECUTE FUNCTION set_source_directory_updated_at();

