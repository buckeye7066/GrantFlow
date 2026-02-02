-- Shoulders of Giants vNext backbone (SQLite)
--
-- IMPORTANT:
-- - This migration is additive and feature-flagged in code (SHOULDERS_VNEXT).
-- - We keep existing Apply Engine tables (`applications`, `application_sections`, etc.) unchanged.

-- 1) Funders
CREATE TABLE IF NOT EXISTS funders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  name TEXT NOT NULL,
  type TEXT,
  urls TEXT DEFAULT '{}' ,        -- JSON: { homepage, apply, guidelines }
  geography TEXT DEFAULT '{}' ,   -- JSON
  domains TEXT DEFAULT '[]'       -- JSON array
);
CREATE INDEX IF NOT EXISTS idx_funders_name ON funders(name);

-- 2) Form schemas (authoritative application forms)
CREATE TABLE IF NOT EXISTS form_schemas (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','scraped','inferred')),
  fields TEXT NOT NULL DEFAULT '[]',           -- JSON array of field defs
  validation_rules TEXT DEFAULT '{}'           -- JSON
);
CREATE INDEX IF NOT EXISTS idx_form_schemas_name ON form_schemas(name);
CREATE INDEX IF NOT EXISTS idx_form_schemas_source ON form_schemas(source);

-- 3) Opportunities (extend funding_opportunities)
-- Note: funding_opportunities already exists in schema.sql; we extend it here for upgrades.
ALTER TABLE funding_opportunities ADD COLUMN funder_id TEXT REFERENCES funders(id) ON DELETE SET NULL;
ALTER TABLE funding_opportunities ADD COLUMN apply_url TEXT;
ALTER TABLE funding_opportunities ADD COLUMN apply_guidelines_url TEXT;
ALTER TABLE funding_opportunities ADD COLUMN currency TEXT;
ALTER TABLE funding_opportunities ADD COLUMN eligibility_json TEXT;         -- JSON
ALTER TABLE funding_opportunities ADD COLUMN cycle_json TEXT;               -- JSON
ALTER TABLE funding_opportunities ADD COLUMN application_mode TEXT CHECK(application_mode IN ('portal','email','paper','unknown'));
ALTER TABLE funding_opportunities ADD COLUMN schema_id TEXT REFERENCES form_schemas(id) ON DELETE SET NULL;
ALTER TABLE funding_opportunities ADD COLUMN status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','expired'));
ALTER TABLE funding_opportunities ADD COLUMN fingerprint TEXT;
ALTER TABLE funding_opportunities ADD COLUMN last_seen_at DATETIME;
ALTER TABLE funding_opportunities ADD COLUMN deadline_at DATETIME;

-- Backfill apply_url from legacy application_url
UPDATE funding_opportunities
SET apply_url = COALESCE(apply_url, application_url)
WHERE apply_url IS NULL AND application_url IS NOT NULL;

-- Backfill status from is_active + deadline (best-effort; deterministic + reversible)
UPDATE funding_opportunities
SET status = CASE
  WHEN is_active = 0 THEN 'paused'
  ELSE 'active'
END
WHERE status IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_funding_opportunities_fingerprint
  ON funding_opportunities(fingerprint)
  WHERE fingerprint IS NOT NULL AND TRIM(fingerprint) <> '';
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_funder_id ON funding_opportunities(funder_id);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_schema_id ON funding_opportunities(schema_id);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_status ON funding_opportunities(status);

-- 4) vNext Applications (canonical deterministic execution unit)
CREATE TABLE IF NOT EXISTS vnext_applications (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,

  stage TEXT NOT NULL DEFAULT 'DISCOVERED',
  state TEXT NOT NULL DEFAULT 'DISCOVERED',

  boundary_type TEXT CHECK(boundary_type IN ('print','portal','paper','none')),
  boundary_url TEXT,

  assigned_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,

  risk_score REAL,              -- 0..1
  expected_value REAL,
  score_breakdown TEXT,         -- JSON
  missing_requirements TEXT,    -- JSON

  UNIQUE(profile_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_vnext_applications_profile_id ON vnext_applications(profile_id);
CREATE INDEX IF NOT EXISTS idx_vnext_applications_opportunity_id ON vnext_applications(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_vnext_applications_state ON vnext_applications(state);

-- 5) vNext Application tasks
CREATE TABLE IF NOT EXISTS vnext_application_tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  application_id TEXT NOT NULL REFERENCES vnext_applications(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL, -- idempotency key per application
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','blocked','done')),
  due_at DATETIME,
  blocking_reason TEXT,
  payload TEXT DEFAULT '{}' , -- JSON

  UNIQUE(application_id, task_key)
);
CREATE INDEX IF NOT EXISTS idx_vnext_tasks_application_id ON vnext_application_tasks(application_id);
CREATE INDEX IF NOT EXISTS idx_vnext_tasks_status ON vnext_application_tasks(status);

-- 6) Documents (extend)
ALTER TABLE documents ADD COLUMN vnext_application_id TEXT REFERENCES vnext_applications(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN storage_uri TEXT;
ALTER TABLE documents ADD COLUMN content_hash TEXT;
ALTER TABLE documents ADD COLUMN extracted_structured TEXT; -- JSON
CREATE INDEX IF NOT EXISTS idx_documents_vnext_app ON documents(vnext_application_id);
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);

-- 7) Audit events (vNext, fine-grained before/after)
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','ai','system')),
  actor_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);

