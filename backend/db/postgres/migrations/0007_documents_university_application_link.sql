-- Link documents to a specific university application entry (student profiles)
-- Keeps school-specific uploads (acceptance letters, scholarship letters, etc.) organized.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS university_application_id TEXT;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS university_application_name TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_university_application_id
  ON documents (university_application_id);

