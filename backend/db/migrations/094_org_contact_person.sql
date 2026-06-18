-- Yana web-crawler enrichment: a public contact person for an organization.
-- contact name/title come from the org's OWN published contact/about page so
-- John's outreach packets can address a real person. Email lives in
-- organizations.email and phone in organizations.phone (existing columns).
ALTER TABLE organizations ADD COLUMN contact_name TEXT;
ALTER TABLE organizations ADD COLUMN contact_title TEXT;
