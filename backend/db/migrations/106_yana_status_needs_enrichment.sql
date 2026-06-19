-- Widen yana_lead_candidates.qualification_status to allow 'needs_enrichment'
-- (outbound prospect discovered with public evidence but no contact channel yet).
--
-- SQLite cannot ALTER/DROP a CHECK constraint, so we rebuild the table. There
-- are no foreign keys referencing yana_lead_candidates, so no PRAGMA dance is
-- needed. Column set = migration 093 + the source/external_id columns added by
-- migration 101 (kept in that exact order so the INSERT...SELECT is a 1:1 copy).

ALTER TABLE yana_lead_candidates RENAME TO yana_lead_candidates_old;

CREATE TABLE yana_lead_candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT,
  profile_id TEXT,
  entity_type TEXT,
  organization_name TEXT,
  organization_type TEXT,
  website_url TEXT,
  location TEXT,
  contact_email TEXT,
  funding_need_summary TEXT,
  grantflow_fit_summary TEXT,
  public_evidence_json TEXT NOT NULL DEFAULT '[]',
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  do_not_contact_flags_json TEXT NOT NULL DEFAULT '[]',
  fit_score INTEGER NOT NULL DEFAULT 0,
  urgency_score INTEGER NOT NULL DEFAULT 0,
  contact_confidence INTEGER NOT NULL DEFAULT 0,
  lead_score INTEGER NOT NULL DEFAULT 0,
  qualification_status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (qualification_status IN ('candidate', 'qualified', 'unqualified', 'needs_enrichment')),
  qualification_reasons_json TEXT NOT NULL DEFAULT '[]',
  pushed_to_john INTEGER NOT NULL DEFAULT 0,
  pushed_at DATETIME,
  run_id TEXT,
  discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source TEXT DEFAULT 'organizations',
  external_id TEXT,
  UNIQUE (organization_id)
);

INSERT INTO yana_lead_candidates (
  id, organization_id, profile_id, entity_type, organization_name,
  organization_type, website_url, location, contact_email, funding_need_summary,
  grantflow_fit_summary, public_evidence_json, source_urls_json,
  do_not_contact_flags_json, fit_score, urgency_score, contact_confidence,
  lead_score, qualification_status, qualification_reasons_json, pushed_to_john,
  pushed_at, run_id, discovered_at, created_at, updated_at, source, external_id
)
SELECT
  id, organization_id, profile_id, entity_type, organization_name,
  organization_type, website_url, location, contact_email, funding_need_summary,
  grantflow_fit_summary, public_evidence_json, source_urls_json,
  do_not_contact_flags_json, fit_score, urgency_score, contact_confidence,
  lead_score, qualification_status, qualification_reasons_json, pushed_to_john,
  pushed_at, run_id, discovered_at, created_at, updated_at, source, external_id
FROM yana_lead_candidates_old;

DROP TABLE yana_lead_candidates_old;

CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_status ON yana_lead_candidates(qualification_status);
CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_pushed ON yana_lead_candidates(pushed_to_john);
CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_profile ON yana_lead_candidates(profile_id);
