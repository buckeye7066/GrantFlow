-- Adds the "Hamilton-generated login" audit trail to hamilton_portal_credentials.
-- See backend/services/hamilton/hamiltonPortalCredentialService.js for the
-- runtime contract; the service ALSO self-heals these columns on boot via
-- ensureSchema, but we ship the migration so production upgrades never
-- depend on a code path that may not have run yet.
ALTER TABLE hamilton_portal_credentials
  ADD COLUMN IF NOT EXISTS generated_by               TEXT;
ALTER TABLE hamilton_portal_credentials
  ADD COLUMN IF NOT EXISTS generation_reason          TEXT;
ALTER TABLE hamilton_portal_credentials
  ADD COLUMN IF NOT EXISTS generated_at               TIMESTAMPTZ;
ALTER TABLE hamilton_portal_credentials
  ADD COLUMN IF NOT EXISTS password_revealed_once_at  TIMESTAMPTZ;
