-- Email → Grant ingestion (Postgres). SQLite parity:
--   backend/db/migrations/110_email_grant_ingestions.sql
--
-- Audit + review log for grant-announcement emails pushed from the owner's
-- inbox bridge (Gmail Apps Script) to /api/email-grants/ingest. Parsed grants
-- with a real applyable URL are upserted into funding_opportunities through the
-- same trust/reality gate every crawler uses.

CREATE TABLE IF NOT EXISTS email_grant_ingestions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'email_inbox',
  message_id TEXT,
  from_email TEXT,
  from_name TEXT,
  subject TEXT,
  received_at TIMESTAMPTZ,
  snippet TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  parse_provider TEXT,
  parsed_json TEXT,
  opportunity_id TEXT,
  profile_id TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_grant_ingestions_msg
  ON email_grant_ingestions(source, message_id)
  WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_grant_ingestions_status ON email_grant_ingestions(status);
CREATE INDEX IF NOT EXISTS idx_email_grant_ingestions_created ON email_grant_ingestions(created_at);
