-- Larry — Lead Discovery & Outreach Agent (SQLite)
--
-- Larry finds likely GrantFlow CLIENTS (prospective customers/users), verifies
-- public organization/contact info, scores fit + urgency, builds lead packets,
-- and (only with admin approval) sends outreach. Larry is NOT a funding-discovery
-- agent (that is Robert) and NOT a user-facing assistant (that is Anya).
--
-- Every table is idempotent (CREATE TABLE IF NOT EXISTS) so re-running this
-- migration on an existing database is safe.

CREATE TABLE IF NOT EXISTS larry_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  prospects_considered INTEGER DEFAULT 0,
  prospects_verified INTEGER DEFAULT 0,
  leads_qualified INTEGER DEFAULT 0,
  packets_built INTEGER DEFAULT 0,
  outreach_drafted INTEGER DEFAULT 0,
  outreach_sent INTEGER DEFAULT 0,
  outreach_failed INTEGER DEFAULT 0,
  outreach_replies INTEGER DEFAULT 0,
  do_not_contact_blocked INTEGER DEFAULT 0,
  rejection_reasons_json TEXT,
  summary_json TEXT,
  error TEXT,
  created_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_larry_runs_started_at ON larry_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_larry_runs_status ON larry_runs(status);

CREATE TABLE IF NOT EXISTS larry_prospect_candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
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
  need_categories_json TEXT,
  programs_json TEXT,
  signals_json TEXT,
  raw_payload_json TEXT,
  discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_checked_at DATETIME,
  status TEXT DEFAULT 'discovered',
  rejection_reason TEXT,
  evidence_json TEXT,
  contact_verification_status TEXT DEFAULT 'unverified',
  contact_verification_reasons_json TEXT,
  fit_score INTEGER,
  urgency_score INTEGER,
  composite_score INTEGER,
  qualified BOOLEAN DEFAULT 0,
  do_not_contact BOOLEAN DEFAULT 0,
  do_not_contact_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- A prospect is unique by (organization_name, normalized_state) when we have no
-- other identifier — but EIN, website, and email are all stronger keys when
-- present. Application code falls back to whichever is available; the indexes
-- below let those lookups stay cheap.
CREATE INDEX IF NOT EXISTS idx_larry_prospects_status ON larry_prospect_candidates(status);
CREATE INDEX IF NOT EXISTS idx_larry_prospects_qualified ON larry_prospect_candidates(qualified, composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_larry_prospects_state ON larry_prospect_candidates(state);
CREATE INDEX IF NOT EXISTS idx_larry_prospects_ein ON larry_prospect_candidates(ein) WHERE ein IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_larry_prospects_website ON larry_prospect_candidates(website_url) WHERE website_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_larry_prospects_email ON larry_prospect_candidates(primary_contact_email) WHERE primary_contact_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_larry_prospects_dnc ON larry_prospect_candidates(do_not_contact) WHERE do_not_contact = 1;

CREATE TABLE IF NOT EXISTS larry_leads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  prospect_candidate_id TEXT NOT NULL,
  run_id TEXT,
  packet_version INTEGER NOT NULL DEFAULT 1,
  packet_json TEXT,
  packet_summary TEXT,
  fit_score INTEGER,
  urgency_score INTEGER,
  composite_score INTEGER,
  fit_reasons_json TEXT,
  urgency_reasons_json TEXT,
  recommended_pitch TEXT,
  recommended_outreach_method TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  qualified_at DATETIME,
  qualified_by_user_id TEXT,
  approved_for_outreach BOOLEAN DEFAULT 0,
  approved_for_outreach_at DATETIME,
  approved_for_outreach_by_user_id TEXT,
  archived_at DATETIME,
  archived_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (prospect_candidate_id, packet_version),
  FOREIGN KEY (prospect_candidate_id) REFERENCES larry_prospect_candidates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_larry_leads_status ON larry_leads(status);
CREATE INDEX IF NOT EXISTS idx_larry_leads_score ON larry_leads(composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_larry_leads_approved ON larry_leads(approved_for_outreach) WHERE approved_for_outreach = 1;

CREATE TABLE IF NOT EXISTS larry_outreach_attempts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lead_id TEXT NOT NULL,
  prospect_candidate_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  template_id TEXT,
  draft_subject TEXT,
  draft_body TEXT,
  draft_text TEXT,
  draft_metadata_json TEXT,
  drafted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  drafted_by TEXT NOT NULL DEFAULT 'larry',
  approved_at DATETIME,
  approved_by_user_id TEXT,
  send_status TEXT NOT NULL DEFAULT 'drafted',
  sent_at DATETIME,
  sent_to_email TEXT,
  sent_to_phone TEXT,
  send_provider TEXT,
  send_provider_message_id TEXT,
  send_error TEXT,
  reply_received_at DATETIME,
  reply_classification TEXT,
  reply_summary TEXT,
  bounce_status TEXT,
  unsubscribed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES larry_leads(id) ON DELETE CASCADE,
  FOREIGN KEY (prospect_candidate_id) REFERENCES larry_prospect_candidates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_larry_outreach_lead ON larry_outreach_attempts(lead_id);
CREATE INDEX IF NOT EXISTS idx_larry_outreach_status ON larry_outreach_attempts(send_status);
CREATE INDEX IF NOT EXISTS idx_larry_outreach_sent_at ON larry_outreach_attempts(sent_at DESC) WHERE sent_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS larry_relationships (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  prospect_candidate_id TEXT NOT NULL,
  relationship_state TEXT NOT NULL DEFAULT 'none',
  last_contacted_at DATETIME,
  last_replied_at DATETIME,
  contact_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until DATETIME,
  do_not_contact BOOLEAN NOT NULL DEFAULT 0,
  do_not_contact_reason TEXT,
  do_not_contact_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (prospect_candidate_id),
  FOREIGN KEY (prospect_candidate_id) REFERENCES larry_prospect_candidates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_larry_relationships_state ON larry_relationships(relationship_state);
CREATE INDEX IF NOT EXISTS idx_larry_relationships_dnc ON larry_relationships(do_not_contact) WHERE do_not_contact = 1;
CREATE INDEX IF NOT EXISTS idx_larry_relationships_cooldown ON larry_relationships(cooldown_until) WHERE cooldown_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS larry_suppression_list (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  reason TEXT,
  added_by_user_id TEXT,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (identifier_type, identifier_value)
);

CREATE INDEX IF NOT EXISTS idx_larry_suppression_value ON larry_suppression_list(identifier_value);

CREATE TABLE IF NOT EXISTS larry_domain_rate_limits (
  domain TEXT PRIMARY KEY,
  window_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_request_at DATETIME,
  blocked_until DATETIME,
  last_error TEXT
);
