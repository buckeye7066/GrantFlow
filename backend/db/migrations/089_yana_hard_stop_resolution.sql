-- 089_yana_hard_stop_resolution.sql
-- @sqlite-continue-on-idempotent-errors
--
-- Yana Hard-Stop Resolution layer. Adds the tables Yana needs to
-- predict, classify, and lawfully resolve every kind of application
-- blocker: missing info, missing documents, login, SSO, 2FA, CAPTCHA,
-- payment, signatures, attestations, portal terms, anti-bot, ambiguous
-- mapping, deadlines, unknown-method, and final-review screens.
--
-- Yana NEVER stores plaintext credentials, NEVER stores raw card data,
-- NEVER stores 2FA codes or session cookies in cleartext. All sensitive
-- fields hold *references* to a downstream secure vault / payment
-- processor / Playwright storage-state file.

CREATE TABLE IF NOT EXISTS yana_blockers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  blocker_type TEXT NOT NULL,           -- one of the 15 categories
  blocker_source TEXT,                  -- preflight | engine | classifier | manual
  blocker_text TEXT,                    -- captured page text / field name
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolution_strategy TEXT,             -- which resolver was attempted
  resolved_at DATETIME,
  unresolved_reason TEXT,
  requires_user_action INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_blockers_task     ON yana_blockers(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_blockers_profile  ON yana_blockers(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_blockers_type     ON yana_blockers(blocker_type);
CREATE INDEX IF NOT EXISTS idx_yana_blockers_open     ON yana_blockers(task_id, resolved_at);

CREATE TABLE IF NOT EXISTS yana_blocker_resolutions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  blocker_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  strategy TEXT NOT NULL,
  outcome TEXT NOT NULL,                -- resolved | blocked | degraded | escalated
  detail TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  resolved_by_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_blocker_res_blocker ON yana_blocker_resolutions(blocker_id);
CREATE INDEX IF NOT EXISTS idx_yana_blocker_res_task    ON yana_blocker_resolutions(task_id);

-- Saved authenticated browser sessions (Playwright storageState file
-- pointers, never the storage state contents themselves).
CREATE TABLE IF NOT EXISTS yana_saved_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,            -- "studentaid.gov", "mtsu.edu", ...
  label TEXT,
  storage_state_path TEXT,              -- on-disk path under YANA_BROWSER_STORAGE_DIR
  storage_state_ref TEXT,               -- alternative: opaque vault reference
  authentication_strategy TEXT,         -- 'sso' | 'username_password' | 'fsa_id' | 'oauth' | ...
  established_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  expires_at DATETIME,
  status TEXT NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','expired','revoked')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_sessions_profile ON yana_saved_sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_sessions_host    ON yana_saved_sessions(portal_host);
CREATE INDEX IF NOT EXISTS idx_yana_sessions_status  ON yana_saved_sessions(status);

-- Pre-authorized payment categories. Payment_method_reference is a
-- token from a PCI-compliant processor (Stripe payment_method_id,
-- etc.). Raw card data is NEVER stored here.
CREATE TABLE IF NOT EXISTS yana_payment_authorizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  category TEXT NOT NULL,               -- 'application_fee' | 'transcript_fee' | 'test_score_send_fee' | 'postage' | 'fax_fee' | 'other'
  max_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_method_reference TEXT,        -- e.g. Stripe pm_xxx
  payment_method_label TEXT,            -- e.g. "Visa ending 4242"
  allowed_portal_hosts TEXT,            -- comma-separated list, NULL = any
  authorization_text TEXT NOT NULL,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  expires_at DATETIME,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_pay_profile ON yana_payment_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_pay_active  ON yana_payment_authorizations(profile_id, category, revoked_at);

-- Standing attestation authorizations. Each row says: "the user has
-- authorized Yana to tick attestation checkboxes that match this
-- category" (e.g. "information is accurate to the best of my
-- knowledge"). Yana NEVER ticks penalty-of-perjury / wet-signature
-- attestations from this table.
CREATE TABLE IF NOT EXISTS yana_attestation_authorizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  category TEXT NOT NULL,               -- 'truthfulness' | 'terms_of_use' | 'authorize_release' | 'eligibility_self_certify' | 'understand_disqualification'
  pattern TEXT NOT NULL,                -- regex source the engine matches
  authorization_text TEXT NOT NULL,
  approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_attest_profile ON yana_attestation_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_attest_active  ON yana_attestation_authorizations(profile_id, category, revoked_at);

-- Portal policy registry. One row per unique portal host telling Yana
-- whether automation is permitted, and what the lawful fallback path
-- is when it is not.
CREATE TABLE IF NOT EXISTS yana_portal_policies (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  portal_host TEXT NOT NULL UNIQUE,
  automation_allowed INTEGER NOT NULL DEFAULT 1,
  agent_submission_allowed INTEGER NOT NULL DEFAULT 1,
  scraping_allowed INTEGER NOT NULL DEFAULT 0,
  api_available INTEGER NOT NULL DEFAULT 0,
  manual_only INTEGER NOT NULL DEFAULT 0,
  fallback_path TEXT,                   -- 'pdf_docx' | 'mail' | 'fax' | 'email' | 'manual' | 'api'
  source_of_policy TEXT,                -- url to the ToS / RPA / public statement
  last_checked_at DATETIME,
  notes TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_policy_host ON yana_portal_policies(portal_host);

-- Resolved-field cache. When Yana asks the user for a missing or
-- ambiguous field once, we save the answer for future portals so the
-- same question is never asked twice.
CREATE TABLE IF NOT EXISTS yana_resolved_fields (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL,
  user_id TEXT,
  field_key TEXT NOT NULL,              -- normalised key, e.g. 'first_name', 'fafsa_efc'
  field_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT,                          -- 'user' | 'admin' | 'document_extraction' | 'ai_mapping'
  metadata_json TEXT NOT NULL DEFAULT '{}',
  resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_resolved_profile ON yana_resolved_fields(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_resolved_key     ON yana_resolved_fields(profile_id, field_key);
