-- Slices 5-6: durable applicant/organization memory and query indexes for
-- the existing IRS-990 transaction ledger. Memory values are revisioned;
-- erasure redacts payloads while retaining a content-free audit chain.

CREATE TABLE IF NOT EXISTS profile_memory_entries (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  memory_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('fact','preference','outcome','relationship','narrative')),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','deleted','expired')),
  retention_policy TEXT NOT NULL DEFAULT 'profile_lifetime'
    CHECK(retention_policy IN ('profile_lifetime','until_date','legal_hold')),
  retention_until DATETIME,
  legal_hold_reason TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK(current_revision > 0),
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  deleted_by_user_id TEXT,
  deletion_reason TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  CHECK(retention_policy <> 'until_date' OR retention_until IS NOT NULL),
  CHECK(retention_policy <> 'legal_hold' OR legal_hold_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_profile_memory_profile
  ON profile_memory_entries(profile_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_memory_organization
  ON profile_memory_entries(organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_memory_retention
  ON profile_memory_entries(status, retention_policy, retention_until);
CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_memory_active_key
  ON profile_memory_entries(profile_id, memory_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS profile_memory_revisions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES profile_memory_entries(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('fact','preference','outcome','relationship','narrative')),
  value_json TEXT NOT NULL DEFAULT '{}',
  source_kind TEXT NOT NULL DEFAULT 'user'
    CHECK(source_kind IN ('user','document','import','system')),
  source_ref TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  change_kind TEXT NOT NULL CHECK(change_kind IN ('create','update','retention','delete','expire')),
  payload_redacted INTEGER NOT NULL DEFAULT 0 CHECK(payload_redacted IN (0,1)),
  created_by_user_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entry_id, revision_number)
);
CREATE INDEX IF NOT EXISTS idx_profile_memory_revision_chain
  ON profile_memory_revisions(entry_id, revision_number DESC);

-- The transaction ledger was introduced in migration 161. These additive
-- indexes keep the canonical intelligence read model bounded and deterministic.
CREATE INDEX IF NOT EXISTS idx_grant_tx_funder_year_amount
  ON grant_transactions(funder_ein, tax_year DESC, amount DESC);
CREATE INDEX IF NOT EXISTS idx_grant_tx_funder_recipient
  ON grant_transactions(funder_ein, recipient_name);
