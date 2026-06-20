-- SQLite parity with backend/db/postgres/migrations/0107_email_grant_ingestions.sql
--
-- Email → Grant ingestion. The owner has a bridge between their inbox and
-- GrantFlow (Gmail Apps Script / forwarding); grant-announcement emails are
-- POSTed to /api/email-grants/ingest, parsed into funding opportunities, and
-- (when a real applyable URL is present) upserted into funding_opportunities
-- through the same trust/reality gate every crawler uses.
--
-- This table is the audit + review log for every email we received: what came
-- in, what we parsed, whether it became a catalog opportunity, and why not.
--
-- TEXT status column (not BOOLEAN) on purpose — the Postgres shim only rewrites
-- `col = 1/0` for an allowlist of known boolean columns, so a fresh BOOLEAN
-- would risk "operator does not exist: boolean = integer".

CREATE TABLE IF NOT EXISTS email_grant_ingestions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'email_inbox',  -- gmail_apps_script | forward | manual
  message_id TEXT,                             -- email Message-ID header (idempotency key)
  from_email TEXT,
  from_name TEXT,
  subject TEXT,
  received_at DATETIME,
  snippet TEXT,                                -- trimmed raw body excerpt (audit)
  status TEXT NOT NULL DEFAULT 'pending',      -- pending|imported|skipped|rejected|error
  parse_provider TEXT,                         -- openai | anthropic | none
  parsed_json TEXT,                            -- extracted grant fields (JSON)
  opportunity_id TEXT,                         -- funding_opportunities.id when imported
  profile_id TEXT,                             -- optional target profile (routing hint)
  reason TEXT,                                 -- skip/error/rejection reason
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_grant_ingestions_msg
  ON email_grant_ingestions(source, message_id)
  WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_grant_ingestions_status ON email_grant_ingestions(status);
CREATE INDEX IF NOT EXISTS idx_email_grant_ingestions_created ON email_grant_ingestions(created_at);
