-- Crawler-doctor provenance: record WHICH query and lane produced each
-- profile-opportunity match, so diagnostics can explain per-row inclusion
-- instead of only aggregate counters. Written by crawlerOsPersistence when the
-- web lane (or any future lane) supplies it; NULL for pre-existing rows.
ALTER TABLE profile_opportunity_matches ADD COLUMN source_query TEXT;
ALTER TABLE profile_opportunity_matches ADD COLUMN discovered_via TEXT;
