-- Yana — Client Discovery / Lead Funnel (mission Goal 14).
--
-- Yana discovers prospective-client leads from GrantFlow's own organization
-- records (a real, network-free internal funnel), qualifies them
-- deterministically, and pushes qualified leads to John for outreach drafting.
--
-- These are the REAL tables that back Yana (the previous adapter read a phantom
-- `yana_lead_candidates` table that was never created, and wrote to `yana_runs`
-- which migration 090 renamed to `hamilton_runs` — so Yana never persisted any
-- real work). `yana_lead_runs` is a NEW, distinct run table (NOT the renamed
-- yana_runs) so Yana and Hamilton never collide.

CREATE TABLE IF NOT EXISTS yana_lead_candidates (
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
    CHECK (qualification_status IN ('candidate', 'qualified', 'unqualified')),
  qualification_reasons_json TEXT NOT NULL DEFAULT '[]',
  pushed_to_john INTEGER NOT NULL DEFAULT 0,
  pushed_at DATETIME,
  run_id TEXT,
  discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id)
);

CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_status ON yana_lead_candidates(qualification_status);
CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_pushed ON yana_lead_candidates(pushed_to_john);
CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_profile ON yana_lead_candidates(profile_id);

CREATE TABLE IF NOT EXISTS yana_lead_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL DEFAULT 'observe',
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  candidates_total INTEGER NOT NULL DEFAULT 0,
  candidates_qualified INTEGER NOT NULL DEFAULT 0,
  leads_pushed_to_john INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_yana_lead_runs_started ON yana_lead_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_yana_lead_runs_status ON yana_lead_runs(status);
