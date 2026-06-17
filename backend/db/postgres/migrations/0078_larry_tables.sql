-- Larry — Lead Discovery & Outreach Agent (Postgres)
--
-- See migrations/082_larry_tables.sql for SQLite. Postgres uses gen_random_uuid()
-- (pgcrypto) and JSONB for structured payloads. Idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS larry_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  prospects_considered INTEGER DEFAULT 0,
  prospects_verified INTEGER DEFAULT 0,
  leads_qualified INTEGER DEFAULT 0,
  packets_built INTEGER DEFAULT 0,
  outreach_drafted INTEGER DEFAULT 0,
  outreach_sent INTEGER DEFAULT 0,
  outreach_failed INTEGER DEFAULT 0,
  outreach_replies INTEGER DEFAULT 0,
  do_not_contact_blocked INTEGER DEFAULT 0,
  rejection_reasons_json JSONB,
  summary_json JSONB,
  error TEXT,
  created_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_larry_runs_started_at ON larry_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_larry_runs_status ON larry_runs(status);

CREATE TABLE IF NOT EXISTS larry_prospect_candidates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT,
  source_name TEXT,
  source_url TEXT,
  source_type TEXT,
  organization_name TEXT NOT NULL,
  organization_legal_name TEXT,
  organization_type TEXT,
  organization_subtype TEXT,
  ein TEXT,
  website_url TEXT,
  primary_contact_name TEXT,
  primary_contact_role TEXT,
  primary_contact_email TEXT,
  primary_contact_phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  county TEXT,
  geography_scope TEXT,
  applicant_type TEXT,
  need_categories_json JSONB,
  programs_json JSONB,
  signals_json JSONB,
  raw_payload_json JSONB,
  discovered_at TIMESTAMPTZ DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ,
  status TEXT DEFAULT 'discovered',
  rejection_reason TEXT,
  evidence_json JSONB,
  contact_verification_status TEXT DEFAULT 'unverified',
  contact_verification_reasons_json JSONB,
  fit_score INTEGER,
  urgency_score INTEGER,
  composite_score INTEGER,
  qualified BOOLEAN DEFAULT FALSE,
  do_not_contact BOOLEAN DEFAULT FALSE,
  do_not_contact_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_larry_prospects_status ON larry_prospect_candidates(status);
CREATE INDEX IF NOT EXISTS idx_larry_prospects_qualified ON larry_prospect_candidates(qualified, composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_larry_prospects_state ON larry_prospect_candidates(state);
CREATE INDEX IF NOT EXISTS idx_larry_prospects_ein ON larry_prospect_candidates(ein) WHERE ein IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_larry_prospects_website ON larry_prospect_candidates(website_url) WHERE website_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_larry_prospects_email ON larry_prospect_candidates(primary_contact_email) WHERE primary_contact_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_larry_prospects_dnc ON larry_prospect_candidates(do_not_contact) WHERE do_not_contact = TRUE;

CREATE TABLE IF NOT EXISTS larry_leads (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  prospect_candidate_id TEXT NOT NULL REFERENCES larry_prospect_candidates(id) ON DELETE CASCADE,
  run_id TEXT,
  packet_version INTEGER NOT NULL DEFAULT 1,
  packet_json JSONB,
  packet_summary TEXT,
  fit_score INTEGER,
  urgency_score INTEGER,
  composite_score INTEGER,
  fit_reasons_json JSONB,
  urgency_reasons_json JSONB,
  recommended_pitch TEXT,
  recommended_outreach_method TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  qualified_at TIMESTAMPTZ,
  qualified_by_user_id TEXT,
  approved_for_outreach BOOLEAN DEFAULT FALSE,
  approved_for_outreach_at TIMESTAMPTZ,
  approved_for_outreach_by_user_id TEXT,
  archived_at TIMESTAMPTZ,
  archived_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (prospect_candidate_id, packet_version)
);

CREATE INDEX IF NOT EXISTS idx_larry_leads_status ON larry_leads(status);
CREATE INDEX IF NOT EXISTS idx_larry_leads_score ON larry_leads(composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_larry_leads_approved ON larry_leads(approved_for_outreach) WHERE approved_for_outreach = TRUE;

CREATE TABLE IF NOT EXISTS larry_outreach_attempts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  lead_id TEXT NOT NULL REFERENCES larry_leads(id) ON DELETE CASCADE,
  prospect_candidate_id TEXT NOT NULL REFERENCES larry_prospect_candidates(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  template_id TEXT,
  draft_subject TEXT,
  draft_body TEXT,
  draft_text TEXT,
  draft_metadata_json JSONB,
  drafted_at TIMESTAMPTZ DEFAULT NOW(),
  drafted_by TEXT NOT NULL DEFAULT 'larry',
  approved_at TIMESTAMPTZ,
  approved_by_user_id TEXT,
  send_status TEXT NOT NULL DEFAULT 'drafted',
  sent_at TIMESTAMPTZ,
  sent_to_email TEXT,
  sent_to_phone TEXT,
  send_provider TEXT,
  send_provider_message_id TEXT,
  send_error TEXT,
  reply_received_at TIMESTAMPTZ,
  reply_classification TEXT,
  reply_summary TEXT,
  bounce_status TEXT,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_larry_outreach_lead ON larry_outreach_attempts(lead_id);
CREATE INDEX IF NOT EXISTS idx_larry_outreach_status ON larry_outreach_attempts(send_status);
CREATE INDEX IF NOT EXISTS idx_larry_outreach_sent_at ON larry_outreach_attempts(sent_at DESC) WHERE sent_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS larry_relationships (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  prospect_candidate_id TEXT NOT NULL REFERENCES larry_prospect_candidates(id) ON DELETE CASCADE,
  relationship_state TEXT NOT NULL DEFAULT 'none',
  last_contacted_at TIMESTAMPTZ,
  last_replied_at TIMESTAMPTZ,
  contact_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until TIMESTAMPTZ,
  do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
  do_not_contact_reason TEXT,
  do_not_contact_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (prospect_candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_larry_relationships_state ON larry_relationships(relationship_state);
CREATE INDEX IF NOT EXISTS idx_larry_relationships_dnc ON larry_relationships(do_not_contact) WHERE do_not_contact = TRUE;
CREATE INDEX IF NOT EXISTS idx_larry_relationships_cooldown ON larry_relationships(cooldown_until) WHERE cooldown_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS larry_suppression_list (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  reason TEXT,
  added_by_user_id TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (identifier_type, identifier_value)
);

CREATE INDEX IF NOT EXISTS idx_larry_suppression_value ON larry_suppression_list(identifier_value);

CREATE TABLE IF NOT EXISTS larry_domain_rate_limits (
  domain TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ DEFAULT NOW(),
  request_count INTEGER NOT NULL DEFAULT 0,
  last_request_at TIMESTAMPTZ,
  blocked_until TIMESTAMPTZ,
  last_error TEXT
);
