BEGIN;

-- Add application guidance fields to grants.
-- Used by the "grant intake advisor" to store how to apply (portal vs direct URL vs contact).

ALTER TABLE grants ADD COLUMN IF NOT EXISTS application_method TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS application_steps TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS contact_phone TEXT;

COMMIT;

