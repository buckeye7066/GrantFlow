-- John — Outreach Drafting Agent (Postgres)
-- See migrations/083_john_tables.sql for SQLite. Idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS john_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  yana_leads_considered INTEGER DEFAULT 0,
  drafts_created INTEGER DEFAULT 0,
  drafts_blocked INTEGER DEFAULT 0,
  drafts_failed INTEGER DEFAULT 0,
  alias_report_json JSONB,
  summary_json JSONB,
  error TEXT,
  created_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_john_runs_started_at ON john_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_john_runs_status ON john_runs(status);

CREATE TABLE IF NOT EXISTS john_email_drafts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
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
  safety_report_json JSONB,
  alias_report_json JSONB,
  personalization_json JSONB,
  source_evidence_json JSONB,
  needs_sender_alias_review BOOLEAN DEFAULT FALSE,
  fallback_used BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  archived_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_john_drafts_status ON john_email_drafts(draft_status);
CREATE INDEX IF NOT EXISTS idx_john_drafts_yana_lead ON john_email_drafts(yana_lead_id);
CREATE INDEX IF NOT EXISTS idx_john_drafts_created_at ON john_email_drafts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_john_drafts_alias_review ON john_email_drafts(needs_sender_alias_review)
  WHERE needs_sender_alias_review = TRUE;

CREATE TABLE IF NOT EXISTS john_suppression_list (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  suppression_type TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT,
  source TEXT,
  added_by_user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (suppression_type, value)
);

CREATE INDEX IF NOT EXISTS idx_john_suppression_value ON john_suppression_list(value);

CREATE TABLE IF NOT EXISTS john_email_audit (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
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
  safety_report_json JSONB,
  alias_report_json JSONB,
  error TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_john_audit_status ON john_email_audit(status);
CREATE INDEX IF NOT EXISTS idx_john_audit_lead ON john_email_audit(yana_lead_id);
CREATE INDEX IF NOT EXISTS idx_john_audit_draft ON john_email_audit(draft_id);
CREATE INDEX IF NOT EXISTS idx_john_audit_created_at ON john_email_audit(created_at DESC);

CREATE TABLE IF NOT EXISTS john_alias_checks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  primary_mailbox TEXT,
  from_alias TEXT,
  alias_verified BOOLEAN DEFAULT FALSE,
  alias_send_supported BOOLEAN DEFAULT FALSE,
  test_draft_provider_id TEXT,
  details_json JSONB,
  error TEXT,
  checked_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_john_alias_checks_at ON john_alias_checks(checked_at DESC);
