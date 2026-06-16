-- John — Outreach Drafting Agent (SQLite)
--
-- John receives qualified lead packets (from Yana / lead-discovery agent),
-- writes personalized outreach emails, and places them into Microsoft Outlook
-- as DRAFTS for Dr. John White to review and send manually. John never sends
-- automatically.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS john_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  yana_leads_considered INTEGER DEFAULT 0,
  drafts_created INTEGER DEFAULT 0,
  drafts_blocked INTEGER DEFAULT 0,
  drafts_failed INTEGER DEFAULT 0,
  alias_report_json TEXT,
  summary_json TEXT,
  error TEXT,
  created_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_john_runs_started_at ON john_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_john_runs_status ON john_runs(status);

CREATE TABLE IF NOT EXISTS john_email_drafts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  yana_lead_id TEXT,
  run_id TEXT,
  organization_name TEXT,
  recipient_email TEXT,
  recipient_name TEXT,
  recipient_role TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  from_mailbox TEXT,
  from_alias TEXT,
  reply_to TEXT,
  display_name TEXT,
  provider TEXT,
  provider_draft_id TEXT,
  provider_message_id TEXT,
  draft_status TEXT NOT NULL DEFAULT 'created',
  safety_status TEXT,
  safety_report_json TEXT,
  alias_report_json TEXT,
  personalization_json TEXT,
  source_evidence_json TEXT,
  needs_sender_alias_review INTEGER DEFAULT 0,
  fallback_used INTEGER DEFAULT 0,
  archived_at DATETIME,
  archived_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_john_drafts_status ON john_email_drafts(draft_status);
CREATE INDEX IF NOT EXISTS idx_john_drafts_yana_lead ON john_email_drafts(yana_lead_id);
CREATE INDEX IF NOT EXISTS idx_john_drafts_created_at ON john_email_drafts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_john_drafts_alias_review ON john_email_drafts(needs_sender_alias_review)
  WHERE needs_sender_alias_review = 1;

CREATE TABLE IF NOT EXISTS john_suppression_list (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  suppression_type TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT,
  source TEXT,
  added_by_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (suppression_type, value)
);

CREATE INDEX IF NOT EXISTS idx_john_suppression_value ON john_suppression_list(value);

CREATE TABLE IF NOT EXISTS john_email_audit (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_name TEXT NOT NULL DEFAULT 'John',
  yana_lead_id TEXT,
  draft_id TEXT,
  recipient_email TEXT,
  organization_name TEXT,
  subject TEXT,
  from_mailbox TEXT,
  from_alias TEXT,
  reply_to TEXT,
  status TEXT NOT NULL,
  provider_draft_id TEXT,
  safety_report_json TEXT,
  alias_report_json TEXT,
  error TEXT,
  created_by_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_john_audit_status ON john_email_audit(status);
CREATE INDEX IF NOT EXISTS idx_john_audit_lead ON john_email_audit(yana_lead_id);
CREATE INDEX IF NOT EXISTS idx_john_audit_draft ON john_email_audit(draft_id);
CREATE INDEX IF NOT EXISTS idx_john_audit_created_at ON john_email_audit(created_at DESC);

CREATE TABLE IF NOT EXISTS john_alias_checks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  primary_mailbox TEXT,
  from_alias TEXT,
  alias_verified INTEGER DEFAULT 0,
  alias_send_supported INTEGER DEFAULT 0,
  test_draft_provider_id TEXT,
  details_json TEXT,
  error TEXT,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_john_alias_checks_at ON john_alias_checks(checked_at DESC);
