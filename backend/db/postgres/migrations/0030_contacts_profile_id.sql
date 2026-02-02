-- Add optional profile_id scoping for contacts (Postgres)
-- Contacts are historically org-scoped; profile_id enables per-profile isolation while
-- preserving org-shared contacts when profile_id IS NULL.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS profile_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_contacts_profile'
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT fk_contacts_profile
      FOREIGN KEY (profile_id) REFERENCES profiles(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_profile ON contacts(profile_id);

