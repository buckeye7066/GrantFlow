-- 0180: Postgres twin of backend/db/migrations/175_workspace_catalog_and_invoice_counters.sql
-- Atomic consultant invoice counters + persist AiArtifact / PartnerSource /
-- SearchJob / Taxonomy (the last declared in-memory stub entities).

CREATE TABLE IF NOT EXISTS consultant_invoice_counters (
  user_id TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS grant_ai_artifacts (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  organization_id TEXT,
  kind TEXT,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_grant_ai_artifacts_grant ON grant_ai_artifacts(grant_id);

CREATE TABLE IF NOT EXISTS workspace_partner_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org_type TEXT,
  api_base_url TEXT,
  contact_email TEXT,
  auth_type TEXT,
  auth_secret_name TEXT,
  status TEXT DEFAULT 'inactive',
  last_success_at TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workspace_partner_sources_name ON workspace_partner_sources(name);

CREATE TABLE IF NOT EXISTS workspace_search_jobs (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  status TEXT,
  progress DOUBLE PRECISION,
  results TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workspace_search_jobs_profile ON workspace_search_jobs(profile_id);
CREATE INDEX IF NOT EXISTS idx_workspace_search_jobs_status ON workspace_search_jobs(status);

CREATE TABLE IF NOT EXISTS workspace_taxonomy (
  id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  label TEXT NOT NULL,
  slug TEXT,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workspace_taxonomy_group ON workspace_taxonomy(group_name);
