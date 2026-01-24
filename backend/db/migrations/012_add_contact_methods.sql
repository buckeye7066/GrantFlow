-- Add contact_methods table (normalized email/phone per organization)

CREATE TABLE IF NOT EXISTS contact_methods (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  type TEXT NOT NULL CHECK(type IN ('email', 'phone')),
  value TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0,

  created_by TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_contact_methods_org ON contact_methods(organization_id);
CREATE INDEX IF NOT EXISTS idx_contact_methods_type ON contact_methods(type);
CREATE INDEX IF NOT EXISTS idx_contact_methods_primary ON contact_methods(is_primary);

