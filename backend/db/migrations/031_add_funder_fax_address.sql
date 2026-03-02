-- Add funder fax and mailing address columns for submission routing
ALTER TABLE grants ADD COLUMN funder_fax TEXT;
ALTER TABLE grants ADD COLUMN funder_address TEXT;
