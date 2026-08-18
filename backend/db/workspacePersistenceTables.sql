-- Applied after schema.sql on every SQLite bootstrap (migrate + applySqliteSchema)
-- so a fresh local DB has consultant + catalog tables even before numbered
-- migrations run. All statements are IF NOT EXISTS / idempotent.
-- @sqlite-continue-on-idempotent-errors

CREATE TABLE IF NOT EXISTS consultant_projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  pricing_model TEXT DEFAULT 'hourly',
  hourly_rate REAL,
  fixed_fee_amount REAL,
  status TEXT DEFAULT 'quoted',
  scope_of_work TEXT,
  payment_option TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consultant_projects_org ON consultant_projects(organization_id);

CREATE TABLE IF NOT EXISTS consultant_time_entries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  grant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  task_category TEXT,
  start_at TEXT,
  end_at TEXT,
  raw_minutes REAL,
  rounded_minutes REAL,
  note TEXT,
  activity_hints TEXT,
  source TEXT DEFAULT 'auto',
  invoiced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consultant_time_entries_org ON consultant_time_entries(organization_id);
CREATE INDEX IF NOT EXISTS idx_consultant_time_entries_grant ON consultant_time_entries(grant_id);
CREATE INDEX IF NOT EXISTS idx_consultant_time_entries_invoiced ON consultant_time_entries(organization_id, invoiced);

CREATE TABLE IF NOT EXISTS consultant_time_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  date TEXT,
  hours REAL,
  description TEXT,
  billable INTEGER DEFAULT 1,
  is_grant_chargeable INTEGER DEFAULT 0,
  hourly_rate REAL,
  total_amount REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consultant_time_logs_org ON consultant_time_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_consultant_time_logs_project ON consultant_time_logs(project_id);

CREATE TABLE IF NOT EXISTS consultant_invoices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT,
  invoice_number TEXT,
  issue_date TEXT,
  due_date TEXT,
  payment_terms TEXT,
  payment_option TEXT,
  subtotal REAL,
  discount_amount REAL,
  discount_description TEXT,
  tax_amount REAL,
  total REAL,
  balance_due REAL,
  amount_paid REAL DEFAULT 0,
  status TEXT DEFAULT 'Draft',
  notes TEXT,
  contract_terms TEXT,
  client_category TEXT,
  qualifies_for_hardship INTEGER DEFAULT 0,
  qualifies_for_ministry_discount INTEGER DEFAULT 0,
  rate_override REAL,
  fee_override REAL,
  milestone_type TEXT,
  service_type TEXT,
  service_description TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consultant_invoices_org ON consultant_invoices(organization_id);
CREATE INDEX IF NOT EXISTS idx_consultant_invoices_number ON consultant_invoices(invoice_number);

CREATE TABLE IF NOT EXISTS consultant_invoice_lines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES consultant_invoices(id) ON DELETE CASCADE,
  description TEXT,
  quantity REAL DEFAULT 1,
  unit_price REAL,
  amount REAL,
  line_order INTEGER DEFAULT 0,
  is_grant_chargeable INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consultant_invoice_lines_invoice ON consultant_invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS consultant_invoice_counters (
  user_id TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS grant_ai_artifacts (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  organization_id TEXT,
  kind TEXT,
  content TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_grant_ai_artifacts_grant ON grant_ai_artifacts(grant_id);

CREATE TABLE IF NOT EXISTS workspace_partner_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org_type TEXT,
  api_base_url TEXT,
  contact_email TEXT,
  auth_type TEXT,
  auth_secret_name TEXT,
  status TEXT DEFAULT 'inactive',
  last_success_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workspace_partner_sources_name ON workspace_partner_sources(name);

CREATE TABLE IF NOT EXISTS workspace_search_jobs (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  status TEXT,
  progress REAL,
  results TEXT,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workspace_search_jobs_profile ON workspace_search_jobs(profile_id);
CREATE INDEX IF NOT EXISTS idx_workspace_search_jobs_status ON workspace_search_jobs(status);

CREATE TABLE IF NOT EXISTS workspace_taxonomy (
  id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  label TEXT NOT NULL,
  slug TEXT,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workspace_taxonomy_group ON workspace_taxonomy(group_name);
