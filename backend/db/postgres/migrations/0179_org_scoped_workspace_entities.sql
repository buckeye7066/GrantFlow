-- 0179: Postgres twin of backend/db/migrations/174_org_scoped_workspace_entities.sql
-- Real persistence for Project / TimeEntry / TimeLog / Invoice / InvoiceLine
-- UI entities that previously wrote to an in-memory client stub.

CREATE TABLE IF NOT EXISTS consultant_projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  pricing_model TEXT DEFAULT 'hourly',
  hourly_rate DOUBLE PRECISION,
  fixed_fee_amount DOUBLE PRECISION,
  status TEXT DEFAULT 'quoted',
  scope_of_work TEXT,
  payment_option TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
  raw_minutes DOUBLE PRECISION,
  rounded_minutes DOUBLE PRECISION,
  note TEXT,
  activity_hints TEXT,
  source TEXT DEFAULT 'auto',
  invoiced INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consultant_time_entries_org ON consultant_time_entries(organization_id);
CREATE INDEX IF NOT EXISTS idx_consultant_time_entries_grant ON consultant_time_entries(grant_id);
CREATE INDEX IF NOT EXISTS idx_consultant_time_entries_invoiced ON consultant_time_entries(organization_id, invoiced);

CREATE TABLE IF NOT EXISTS consultant_time_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  date TEXT,
  hours DOUBLE PRECISION,
  description TEXT,
  billable INTEGER DEFAULT 1,
  is_grant_chargeable INTEGER DEFAULT 0,
  hourly_rate DOUBLE PRECISION,
  total_amount DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
  subtotal DOUBLE PRECISION,
  discount_amount DOUBLE PRECISION,
  discount_description TEXT,
  tax_amount DOUBLE PRECISION,
  total DOUBLE PRECISION,
  balance_due DOUBLE PRECISION,
  amount_paid DOUBLE PRECISION DEFAULT 0,
  status TEXT DEFAULT 'Draft',
  notes TEXT,
  contract_terms TEXT,
  client_category TEXT,
  qualifies_for_hardship INTEGER DEFAULT 0,
  qualifies_for_ministry_discount INTEGER DEFAULT 0,
  rate_override DOUBLE PRECISION,
  fee_override DOUBLE PRECISION,
  milestone_type TEXT,
  service_type TEXT,
  service_description TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consultant_invoices_org ON consultant_invoices(organization_id);
CREATE INDEX IF NOT EXISTS idx_consultant_invoices_number ON consultant_invoices(invoice_number);

CREATE TABLE IF NOT EXISTS consultant_invoice_lines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES consultant_invoices(id) ON DELETE CASCADE,
  description TEXT,
  quantity DOUBLE PRECISION DEFAULT 1,
  unit_price DOUBLE PRECISION,
  amount DOUBLE PRECISION,
  line_order INTEGER DEFAULT 0,
  is_grant_chargeable INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consultant_invoice_lines_invoice ON consultant_invoice_lines(invoice_id);
