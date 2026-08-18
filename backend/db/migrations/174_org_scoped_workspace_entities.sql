-- 174: real persistence for consultant workspace UI entities that silently
-- wrote to the in-memory client stub (createStubEntityClient) and vanished
-- on reload: Project, TimeEntry, TimeLog, Invoice, InvoiceLine.
-- Distinct from subscription billing_invoices / billing_accounts.
-- Postgres twin: backend/db/postgres/migrations/0179_org_scoped_workspace_entities.sql

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
