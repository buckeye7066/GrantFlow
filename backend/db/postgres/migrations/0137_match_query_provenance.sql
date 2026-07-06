-- Crawler-doctor provenance: twin of sqlite migration 133_match_query_provenance.sql.
ALTER TABLE profile_opportunity_matches ADD COLUMN IF NOT EXISTS source_query TEXT;
ALTER TABLE profile_opportunity_matches ADD COLUMN IF NOT EXISTS discovered_via TEXT;
