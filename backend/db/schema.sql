-- GrantFlow Database Schema
-- SQLite version for Railway deployment

-- Organizations (clients/applicants)
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  
  -- Basic Info
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  profile_image_url TEXT,
  applicant_type TEXT CHECK(applicant_type IN ('individual_need', 'nonprofit', 'small_business', 'student', 'government', 'other')),
  pro_bono BOOLEAN DEFAULT FALSE,
  
  -- Demographics
  date_of_birth DATE,
  age INTEGER,
  
  -- Address
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  
  -- Organization Details (for nonprofits)
  website TEXT,
  ein TEXT,
  uei TEXT,
  cage_code TEXT,
  organization_type TEXT,
  nonprofit_type TEXT,
  annual_budget REAL,
  staff_count INTEGER,
  mission TEXT,
  
  -- Qualifications
  federal_registrations TEXT DEFAULT '[]', -- JSON array
  audited_financials BOOLEAN DEFAULT FALSE,
  indirect_cost_rate REAL,
  
  -- Education (for students)
  current_college TEXT,
  target_colleges TEXT DEFAULT '[]', -- JSON array
  intended_major TEXT,
  planned_enrollment_term TEXT,
  planned_enrollment_year INTEGER,
  gpa REAL,
  act_score INTEGER,
  sat_score INTEGER,
  first_generation BOOLEAN DEFAULT FALSE,
  
  -- Financial
  household_income REAL,
  household_size INTEGER,
  financial_challenges TEXT DEFAULT '[]', -- JSON array
  
  -- Benefits/Assistance
  government_assistance TEXT DEFAULT '[]', -- JSON array
  medicaid_enrolled BOOLEAN DEFAULT FALSE,
  medicare_recipient BOOLEAN DEFAULT FALSE,
  ssi_recipient BOOLEAN DEFAULT FALSE,
  ssdi_recipient BOOLEAN DEFAULT FALSE,
  snap_recipient BOOLEAN DEFAULT FALSE,
  tanf_recipient BOOLEAN DEFAULT FALSE,
  section8_housing BOOLEAN DEFAULT FALSE,
  
  -- Military
  veteran BOOLEAN DEFAULT FALSE,
  disabled_veteran BOOLEAN DEFAULT FALSE,
  military_branch TEXT,
  military_spouse BOOLEAN DEFAULT FALSE,
  gold_star_family BOOLEAN DEFAULT FALSE,
  
  -- Health/Disability
  disabilities TEXT DEFAULT '[]', -- JSON array
  rare_disease BOOLEAN DEFAULT FALSE,
  
  -- Household
  single_parent BOOLEAN DEFAULT FALSE,
  homeless BOOLEAN DEFAULT FALSE,
  foster_care BOOLEAN DEFAULT FALSE,
  
  -- Matching Keywords
  keywords TEXT DEFAULT '[]', -- JSON array
  focus_areas TEXT DEFAULT '[]', -- JSON array
  program_areas TEXT DEFAULT '[]', -- JSON array
  funding_amount_needed TEXT,
  
  -- Misc
  notes TEXT
);

-- Funding Opportunities (master list of available grants)
CREATE TABLE IF NOT EXISTS funding_opportunities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  title TEXT NOT NULL,
  sponsor TEXT,
  source TEXT, -- 'grants.gov', 'foundation', 'state', 'federal', etc.
  source_id TEXT, -- external ID from source
  source_url TEXT,
  
  description TEXT,
  eligibility_bullets TEXT DEFAULT '[]', -- JSON array
  
  amount_min REAL,
  amount_max REAL,
  amount_description TEXT,
  
  deadline DATE,
  deadline_type TEXT CHECK(deadline_type IN ('fixed', 'rolling', 'ongoing', 'unknown')),
  
  application_url TEXT,
  
  -- Geographic
  is_national BOOLEAN DEFAULT FALSE,
  state TEXT,
  regions TEXT DEFAULT '[]', -- JSON array
  
  -- Categories
  categories TEXT DEFAULT '[]', -- JSON array
  keywords TEXT DEFAULT '[]', -- JSON array
  opportunity_type TEXT, -- 'grant', 'scholarship', 'loan', 'benefit', etc.
  
  -- Requirements
  requires_501c3 BOOLEAN DEFAULT FALSE,
  requires_match BOOLEAN DEFAULT FALSE,
  match_percentage REAL,
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  last_crawled DATETIME,
  
  -- For tracking which profiles this was matched to
  profile_id TEXT
);

-- Grants (opportunities being actively tracked/pursued)
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  funding_opportunity_id TEXT REFERENCES funding_opportunities(id),
  
  title TEXT NOT NULL,
  funder TEXT,
  
  amount_requested REAL,
  amount_awarded REAL,
  
  status TEXT DEFAULT 'discovered' CHECK(status IN (
    'discovered', 'interested', 'drafting', 'app_prep', 'revision', 
    'submitted', 'under_review', 'awarded', 'rejected', 'closed', 'archived'
  )),
  
  deadline DATE,
  submitted_date DATE,
  award_date DATE,
  start_date DATE,
  end_date DATE,
  
  match_score INTEGER,
  match_reasons TEXT DEFAULT '[]', -- JSON array
  
  notes TEXT,
  
  application_url TEXT,
  portal_url TEXT,
  
  -- Tracking
  assigned_to TEXT,
  priority TEXT CHECK(priority IN ('low', 'medium', 'high', 'urgent'))
);

-- Milestones
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  grant_id TEXT REFERENCES grants(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  
  completed BOOLEAN DEFAULT FALSE,
  completed_date DATE,
  
  type TEXT, -- 'deadline', 'report', 'deliverable', 'meeting', etc.
  reminder_days INTEGER DEFAULT 7
);

-- Documents
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id TEXT REFERENCES grants(id) ON DELETE SET NULL,
  
  name TEXT NOT NULL,
  type TEXT, -- 'proposal', 'budget', 'letter_of_support', 'form', 'report', etc.
  
  file_url TEXT,
  file_path TEXT,
  file_size INTEGER,
  mime_type TEXT,
  
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'review', 'final', 'submitted')),
  version INTEGER DEFAULT 1,
  
  notes TEXT
);

-- Expenses
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  grant_id TEXT REFERENCES grants(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT,
  date DATE,
  
  receipt_url TEXT,
  approved BOOLEAN DEFAULT FALSE,
  approved_by TEXT,
  approved_date DATE,
  
  notes TEXT
);

-- Budgets
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  grant_id TEXT REFERENCES grants(id) ON DELETE CASCADE,
  
  name TEXT NOT NULL,
  total_amount REAL,
  
  line_items TEXT DEFAULT '[]', -- JSON array of budget line items
  
  status TEXT DEFAULT 'draft'
);

-- Application Drafts
CREATE TABLE IF NOT EXISTS application_drafts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  grant_id TEXT REFERENCES grants(id) ON DELETE CASCADE,
  
  section_name TEXT,
  section_order INTEGER,
  
  prompt TEXT, -- The question/prompt
  content TEXT, -- User's answer
  ai_suggestions TEXT, -- AI-generated suggestions
  
  word_limit INTEGER,
  word_count INTEGER,
  
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'review', 'final'))
);

-- Contacts
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  
  name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  
  type TEXT, -- 'primary', 'program_officer', 'fiscal', 'board', etc.
  notes TEXT
);

-- Crawl Logs (for tracking data imports)
CREATE TABLE IF NOT EXISTS crawl_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  source TEXT NOT NULL,
  status TEXT CHECK(status IN ('started', 'success', 'error', 'partial')),
  
  records_found INTEGER DEFAULT 0,
  records_imported INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  
  duration_ms INTEGER,
  error_message TEXT,
  
  metadata TEXT -- JSON
);

-- AI Artifacts (saved AI-generated content)
CREATE TABLE IF NOT EXISTS ai_artifacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id TEXT REFERENCES grants(id) ON DELETE SET NULL,
  
  type TEXT, -- 'match_analysis', 'proposal_draft', 'letter', etc.
  prompt TEXT,
  content TEXT,
  
  model TEXT,
  tokens_used INTEGER,
  
  rating INTEGER, -- User rating 1-5
  feedback TEXT
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_organizations_state ON organizations(state);
CREATE INDEX IF NOT EXISTS idx_organizations_applicant_type ON organizations(applicant_type);
CREATE INDEX IF NOT EXISTS idx_grants_organization_id ON grants(organization_id);
CREATE INDEX IF NOT EXISTS idx_grants_status ON grants(status);
CREATE INDEX IF NOT EXISTS idx_grants_deadline ON grants(deadline);
CREATE INDEX IF NOT EXISTS idx_opportunities_deadline ON funding_opportunities(deadline);
CREATE INDEX IF NOT EXISTS idx_opportunities_is_active ON funding_opportunities(is_active);
CREATE INDEX IF NOT EXISTS idx_opportunities_state ON funding_opportunities(state);
CREATE INDEX IF NOT EXISTS idx_milestones_due_date ON milestones(due_date);
CREATE INDEX IF NOT EXISTS idx_milestones_grant_id ON milestones(grant_id);
CREATE INDEX IF NOT EXISTS idx_documents_organization_id ON documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_expenses_grant_id ON expenses(grant_id);

-- Triggers to auto-update updated_at
CREATE TRIGGER IF NOT EXISTS update_organizations_timestamp 
AFTER UPDATE ON organizations
BEGIN
  UPDATE organizations SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_grants_timestamp 
AFTER UPDATE ON grants
BEGIN
  UPDATE grants SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_funding_opportunities_timestamp 
AFTER UPDATE ON funding_opportunities
BEGIN
  UPDATE funding_opportunities SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
