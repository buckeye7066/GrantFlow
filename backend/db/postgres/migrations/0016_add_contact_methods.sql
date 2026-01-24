-- Add contact_methods table (normalized email/phone per organization)

CREATE TABLE IF NOT EXISTS contact_methods (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  type TEXT NOT NULL CHECK(type IN ('email', 'phone')),
  value TEXT NOT NULL,
  is_primary BOOLEAN DEFAULT FALSE,

  created_by TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_contact_methods_org ON contact_methods(organization_id);
CREATE INDEX IF NOT EXISTS idx_contact_methods_type ON contact_methods(type);
CREATE INDEX IF NOT EXISTS idx_contact_methods_primary ON contact_methods(is_primary);

-- updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $fn$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END$$;

DROP TRIGGER IF EXISTS trg_contact_methods_updated_at ON contact_methods;
CREATE TRIGGER trg_contact_methods_updated_at
BEFORE UPDATE ON contact_methods
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

