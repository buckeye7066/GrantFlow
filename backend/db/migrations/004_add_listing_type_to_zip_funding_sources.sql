-- Migration 004: Add listing_type to zip_funding_sources (avoid source_type meaning collision)
-- Date: 2026-01-11
--
-- Context:
-- - `source_type` is used elsewhere (UI/forms) for organization/source classification with many values.
-- - This table uses OPPORTUNITY/PROGRAM/DIRECTORY, which is a different taxonomy ("listing type").
-- - We add a new column `listing_type` and backfill from legacy `source_type`.
-- - For one release, crawlers may continue writing BOTH columns for backward compatibility.

-- Ensure legacy table exists (older installs created this from the crawler itself)
CREATE TABLE IF NOT EXISTS zip_funding_sources (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  zip_code TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('OPPORTUNITY', 'PROGRAM', 'DIRECTORY')),
  evidence_url TEXT,
  evidence_title TEXT,
  last_verified_at DATETIME,
  number_of_opportunities_found INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_zip_sources_zip ON zip_funding_sources(zip_code);
CREATE INDEX IF NOT EXISTS idx_zip_sources_type ON zip_funding_sources(source_type);

-- Add canonical column and backfill from legacy column.
ALTER TABLE zip_funding_sources
ADD COLUMN listing_type TEXT CHECK(listing_type IN ('OPPORTUNITY', 'PROGRAM', 'DIRECTORY'));

UPDATE zip_funding_sources
SET listing_type = source_type
WHERE listing_type IS NULL AND source_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_zip_sources_listing_type ON zip_funding_sources(listing_type);

