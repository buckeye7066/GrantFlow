-- Add optional profile_id scoping for contacts (SQLite)
-- Contacts are historically org-scoped; profile_id enables per-profile isolation while
-- preserving org-shared contacts when profile_id IS NULL.

ALTER TABLE contacts ADD COLUMN profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_profile ON contacts(profile_id);

