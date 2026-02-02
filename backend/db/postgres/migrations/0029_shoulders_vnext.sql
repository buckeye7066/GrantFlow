-- Shoulders of Giants vNext backbone (Postgres)
-- Additive + feature-flagged in code (SHOULDERS_VNEXT).

-- 1) Funders
CREATE TABLE IF NOT EXISTS funders (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  name TEXT NOT NULL,
  type TEXT,
  urls JSONB DEFAULT '{}'::jsonb,
  geography JSONB DEFAULT '{}'::jsonb,
  domains TEXT[] DEFAULT '{}'::text[]
);
CREATE INDEX IF NOT EXISTS idx_funders_name ON funders(name);

-- 2) Form schemas
CREATE TABLE IF NOT EXISTS form_schemas (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','scraped','inferred')),
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_rules JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_form_schemas_name ON form_schemas(name);
CREATE INDEX IF NOT EXISTS idx_form_schemas_source ON form_schemas(source);

-- 3) Opportunities (extend funding_opportunities)
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS funder_id TEXT REFERENCES funders(id) ON DELETE SET NULL;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS apply_url TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS apply_guidelines_url TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS eligibility_json JSONB;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS cycle_json JSONB;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS application_mode TEXT CHECK(application_mode IN ('portal','email','paper','unknown'));
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS schema_id TEXT REFERENCES form_schemas(id) ON DELETE SET NULL;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','expired'));
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;

-- Backfill apply_url from legacy application_url
UPDATE funding_opportunities
SET apply_url = COALESCE(apply_url, application_url)
WHERE apply_url IS NULL AND application_url IS NOT NULL;

-- Backfill status from is_active (best-effort)
UPDATE funding_opportunities
SET status = CASE
  WHEN is_active = FALSE THEN 'paused'
  ELSE 'active'
END
WHERE status IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_funding_opportunities_fingerprint
  ON funding_opportunities(fingerprint)
  WHERE fingerprint IS NOT NULL AND btrim(fingerprint) <> '';
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_funder_id ON funding_opportunities(funder_id);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_schema_id ON funding_opportunities(schema_id);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_status ON funding_opportunities(status);

-- 4) vNext applications
CREATE TABLE IF NOT EXISTS vnext_applications (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,

  stage TEXT NOT NULL DEFAULT 'DISCOVERED',
  state TEXT NOT NULL DEFAULT 'DISCOVERED',

  boundary_type TEXT CHECK(boundary_type IN ('print','portal','paper','none')),
  boundary_url TEXT,

  assigned_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,

  risk_score DOUBLE PRECISION,
  expected_value DOUBLE PRECISION,
  score_breakdown JSONB,
  missing_requirements JSONB,

  UNIQUE(profile_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_vnext_applications_profile_id ON vnext_applications(profile_id);
CREATE INDEX IF NOT EXISTS idx_vnext_applications_opportunity_id ON vnext_applications(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_vnext_applications_state ON vnext_applications(state);

-- 5) vNext application tasks
CREATE TABLE IF NOT EXISTS vnext_application_tasks (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  application_id TEXT NOT NULL REFERENCES vnext_applications(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','blocked','done')),
  due_at TIMESTAMPTZ,
  blocking_reason TEXT,
  payload JSONB DEFAULT '{}'::jsonb,

  UNIQUE(application_id, task_key)
);
CREATE INDEX IF NOT EXISTS idx_vnext_tasks_application_id ON vnext_application_tasks(application_id);
CREATE INDEX IF NOT EXISTS idx_vnext_tasks_status ON vnext_application_tasks(status);

-- 6) Documents (extend)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS vnext_application_id TEXT REFERENCES vnext_applications(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_uri TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extracted_structured JSONB;
CREATE INDEX IF NOT EXISTS idx_documents_vnext_app ON documents(vnext_application_id);
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);

-- 7) Audit events
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  created_at TIMESTAMPTZ DEFAULT now(),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','ai','system')),
  actor_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json JSONB,
  after_json JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);

