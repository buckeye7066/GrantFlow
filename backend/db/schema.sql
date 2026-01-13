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
  applicant_type TEXT CHECK(applicant_type IN (
    'individual_need',
    'family',
    'organization',
    'nonprofit',
    'small_business',
    'student',
    'college_student',
    'high_school_student',
    'medical_assistance',
    'government',
    'other'
  )),
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
  record_origin TEXT DEFAULT 'live_crawl' CHECK(record_origin IN ('live_crawl','curated_verified','manual','synthetic')),
  
  description TEXT,
  eligibility_bullets TEXT DEFAULT '[]', -- JSON array
  
  amount_min REAL,
  amount_max REAL,
  amount_description TEXT,
  
  deadline DATE,
  deadline_type TEXT CHECK(deadline_type IN ('fixed', 'rolling', 'ongoing', 'unknown')),
  
  application_url TEXT,
  
  -- Contact information (JSON: { name, email, phone, address, website })
  contact_info TEXT DEFAULT NULL,
  
  -- Geographic
  is_national BOOLEAN DEFAULT FALSE,
  state TEXT,
  regions TEXT DEFAULT '[]', -- JSON array
  
  -- Categories
  categories TEXT DEFAULT '[]', -- JSON array
  keywords TEXT DEFAULT '[]', -- JSON array
  opportunity_type TEXT, -- 'grant', 'scholarship', 'loan', 'benefit', etc.
  type TEXT DEFAULT 'OPPORTUNITY' CHECK(type IN ('OPPORTUNITY', 'PROGRAM', 'DIRECTORY')),
  evidence_url TEXT, -- URL used to verify this opportunity
  last_verified_at DATETIME, -- Last time this was verified as real
  
  -- Requirements
  requires_501c3 BOOLEAN DEFAULT FALSE,
  requires_match BOOLEAN DEFAULT FALSE,
  match_percentage REAL,
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  last_crawled DATETIME,
  
  -- For tracking which profiles this was matched to
  match_reasons TEXT DEFAULT '[]', -- JSON array
  notes TEXT,
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
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  
  name TEXT NOT NULL,
  type TEXT, -- 'proposal', 'budget', 'letter_of_support', 'form', 'report', etc.
  
  file_url TEXT,
  file_path TEXT,
  file_size INTEGER,
  mime_type TEXT,
  extracted_text TEXT,
  ai_summary TEXT,
  ai_sections TEXT,
  processing_status TEXT DEFAULT 'pending' CHECK(processing_status IN ('pending', 'processing', 'completed', 'failed')),
  processing_error TEXT,
  
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'review', 'final', 'submitted')),
  version INTEGER DEFAULT 1,
  
  notes TEXT
);

-- Grant monitoring alert configs (used by Grant Monitoring page)
CREATE TABLE IF NOT EXISTS grant_monitoring_alerts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_date DATETIME DEFAULT CURRENT_TIMESTAMP,

  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK(alert_type IN ('deadline_approaching','status_change','new_match','milestone_due')),
  enabled BOOLEAN DEFAULT TRUE,
  threshold_days INTEGER,
  notification_methods TEXT DEFAULT '[]' -- JSON array
);

-- Grant monitoring logs (events generated by periodic checks)
CREATE TABLE IF NOT EXISTS grant_monitoring_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_date DATETIME DEFAULT CURRENT_TIMESTAMP,

  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id TEXT REFERENCES grants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','high','critical')),
  event_data TEXT DEFAULT '{}' , -- JSON

  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at DATETIME
);

-- Users & authentication
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  display_name TEXT,
  primary_email TEXT,
  primary_phone TEXT,
  avatar_url TEXT,
  is_admin BOOLEAN DEFAULT 0,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS user_credentials (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('email_otp', 'phone_otp')),
  identifier TEXT NOT NULL,
  secret_hash TEXT,
  verified_at DATETIME,
  last_sent_at DATETIME,
  attempt_count INTEGER DEFAULT 0,
  UNIQUE(type, identifier)
);

CREATE TABLE IF NOT EXISTS user_verification_codes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  credential_id TEXT NOT NULL REFERENCES user_credentials(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME,
  attempt_count INTEGER DEFAULT 0,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS user_providers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at DATETIME,
  scopes TEXT,
  metadata TEXT,
  UNIQUE(provider, provider_account_id)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  access_expires_at DATETIME,
  refresh_expires_at DATETIME,
  refresh_token_hash TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  revoked_at DATETIME
);

CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  provider TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  code_verifier TEXT,
  redirect_to TEXT,
  metadata TEXT,
  expires_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS billing_tiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  base_monthly_cents INTEGER,
  hourly_rate_cents INTEGER,
  enable_pipeline_automation BOOLEAN DEFAULT 0,
  enable_item_funding BOOLEAN DEFAULT 0,
  enable_document_ai BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS grant_pipeline_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES crawler_jobs(id) ON DELETE SET NULL,
  previous_status TEXT,
  suggested_status TEXT,
  applied_status TEXT,
  confidence REAL,
  handoff_required BOOLEAN DEFAULT 0,
  handoff_reason TEXT,
  recommended_actions TEXT, -- JSON array
  ai_summary TEXT
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

INSERT OR IGNORE INTO billing_tiers (
  id,
  name,
  description,
  base_monthly_cents,
  hourly_rate_cents,
  enable_pipeline_automation,
  enable_item_funding,
  enable_document_ai
) VALUES
  (
    'foundation',
    'Foundation',
    'Baseline research support with curated grant discovery and shared AI document enrichment.',
    0,
    0,
    0,
    1,
    1
  ),
  (
    'growth',
    'Growth',
    'Expanded automation, itemized funding intelligence, and AI-supported document ingestion.',
    9900,
    15000,
    1,
    1,
    1
  ),
  (
    'enterprise',
    'Enterprise',
    'Full-service concierge with custom automation rules and dedicated analyst support.',
    24900,
    22500,
    1,
    1,
    1
  );

-- Profiles (comprehensive application records)
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  
  primary_type TEXT, -- e.g. organization, high_school_student, etc.
  display_name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  tags TEXT DEFAULT '[]',
  avatar_url TEXT
);

CREATE TABLE IF NOT EXISTS profile_sections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON payload of section fields
  updated_by TEXT,
  
  UNIQUE(profile_id, section_key)
);

CREATE TABLE IF NOT EXISTS profile_documents (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, document_id)
);

CREATE TABLE IF NOT EXISTS billing_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES billing_tiers(id),
  assigned_by TEXT,
  assigned_reason TEXT,
  discount_type TEXT CHECK(discount_type IN ('none', 'student', 'minister')),
  discount_percent REAL DEFAULT 0,
  is_pro_bono BOOLEAN DEFAULT 0,
  pro_bono_reason TEXT,
  custom_monthly_cents INTEGER,
  custom_hourly_cents INTEGER,
  metadata TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_accounts_profile ON billing_accounts(profile_id);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_tier ON billing_accounts(tier_id);

CREATE TABLE IF NOT EXISTS billing_account_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  changed_by TEXT,
  previous_tier_id TEXT,
  new_tier_id TEXT,
  previous_discount_type TEXT,
  new_discount_type TEXT,
  previous_discount_percent REAL,
  new_discount_percent REAL,
  previous_pro_bono BOOLEAN,
  new_pro_bono BOOLEAN,
  notes TEXT
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
CREATE INDEX IF NOT EXISTS idx_grant_pipeline_events_grant ON grant_pipeline_events(grant_id);
CREATE INDEX IF NOT EXISTS idx_grant_pipeline_events_created ON grant_pipeline_events(created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_grant_id ON expenses(grant_id);
CREATE INDEX IF NOT EXISTS idx_profiles_primary_type ON profiles(primary_type);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profile_sections_profile ON profile_sections(profile_id);
CREATE INDEX IF NOT EXISTS idx_users_primary_email ON users(primary_email);
CREATE INDEX IF NOT EXISTS idx_user_credentials_identifier ON user_credentials(identifier);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_refresh_hash ON user_sessions(refresh_token_hash);

-- Crawler jobs
CREATE TABLE IF NOT EXISTS crawler_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  
  type TEXT NOT NULL CHECK(type IN (
    'local',
    'scholarship',
    'comprehensive',
    'national',
    'item_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
    'national_zip_scan'
  )),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled'
  )),
  
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  
  parameters TEXT DEFAULT '{}',
  result_count INTEGER DEFAULT 0,
  result_meta TEXT,
  error TEXT,
  requested_by TEXT,
  retry_count INTEGER DEFAULT 0,
  last_retry_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status ON crawler_jobs(status);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_profile ON crawler_jobs(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_type ON crawler_jobs(type);

-- National ZIP progress tracking for Geo Crawl (comprehensive with mode='geo')
CREATE TABLE IF NOT EXISTS national_zip_progress (
  zip TEXT PRIMARY KEY,
  last_run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sources_found INTEGER DEFAULT 0,
  cursor_meta TEXT DEFAULT '{}', -- JSON for pagination/state
  status TEXT DEFAULT 'pending' CHECK(status IN (
    'pending',
    'in_progress',
    'completed',
    'failed',
    'skipped'
  )),
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_national_zip_status ON national_zip_progress(status);
CREATE INDEX IF NOT EXISTS idx_national_zip_last_run ON national_zip_progress(last_run_at);

-- Anya assistant sessions
CREATE TABLE IF NOT EXISTS anya_sessions (
  id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed')),
  title TEXT,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_anya_sessions_user ON anya_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_anya_sessions_profile ON anya_sessions(profile_id);

CREATE TABLE IF NOT EXISTS anya_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES anya_sessions(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_anya_messages_session ON anya_messages(session_id);

CREATE TABLE IF NOT EXISTS anya_tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id TEXT NOT NULL REFERENCES anya_sessions(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'completed', 'cancelled')),
  priority TEXT DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
  due_date DATE,
  completed_at DATETIME,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_anya_tasks_session ON anya_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_anya_tasks_status ON anya_tasks(status);

-- User Preferences
CREATE TABLE IF NOT EXISTS user_preferences (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  
  -- UI Preferences
  sidebar_position TEXT DEFAULT 'left',
  sidebar_collapsed INTEGER DEFAULT 0,
  dashboard_layout TEXT DEFAULT 'grid',
  card_density TEXT DEFAULT 'comfortable',
  table_row_density TEXT DEFAULT 'medium',
  
  -- Theme Preferences
  theme TEXT DEFAULT 'system',
  accent_color TEXT DEFAULT 'blue',
  sidebar_color_scheme TEXT DEFAULT 'default',
  high_contrast INTEGER DEFAULT 0,
  
  -- Navigation Preferences
  default_landing_page TEXT DEFAULT '/Dashboard',
  items_per_page INTEGER DEFAULT 25,
  
  -- Display Preferences
  date_format TEXT DEFAULT 'MM/DD/YYYY',
  currency_display TEXT DEFAULT 'USD',
  timezone TEXT DEFAULT 'America/New_York',
  
  -- Notification Preferences
  email_notifications INTEGER DEFAULT 1,
  grant_deadline_reminder_days INTEGER DEFAULT 7,
  weekly_digest INTEGER DEFAULT 1,
  browser_notifications INTEGER DEFAULT 0,
  
  -- Accessibility Preferences
  font_size TEXT DEFAULT 'medium',
  reduce_motion INTEGER DEFAULT 0,
  screen_reader_optimized INTEGER DEFAULT 0,
  
  -- Custom JSON preferences (for features like onboarding_video_seen)
  custom_preferences TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);

-- Crawler Schedules
CREATE TABLE IF NOT EXISTS crawler_schedules (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  crawler_type TEXT NOT NULL,
  schedule_cron TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_run_at DATETIME,
  next_run_at DATETIME,
  last_saved_count INTEGER DEFAULT 0,
  total_opportunities_saved INTEGER DEFAULT 0,
  parameters TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_crawler_schedules_profile ON crawler_schedules(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_schedules_enabled ON crawler_schedules(enabled);

-- Triggers to auto-update updated_at
CREATE TRIGGER IF NOT EXISTS update_anya_sessions_timestamp
AFTER UPDATE ON anya_sessions
BEGIN
  UPDATE anya_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_anya_tasks_timestamp
AFTER UPDATE ON anya_tasks
BEGIN
  UPDATE anya_tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

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

CREATE TRIGGER IF NOT EXISTS update_profiles_timestamp
AFTER UPDATE ON profiles
BEGIN
  UPDATE profiles SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_profile_sections_timestamp
AFTER UPDATE ON profile_sections
BEGIN
  UPDATE profile_sections SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_user_preferences_timestamp
AFTER UPDATE ON user_preferences
BEGIN
  UPDATE user_preferences SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_crawler_schedules_timestamp
AFTER UPDATE ON crawler_schedules
BEGIN
  UPDATE crawler_schedules SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- ============================================================
-- National Funding & Benefits Programs (TRACKED DATASETS)
-- IMPORTANT: Track A (CLIENT) and Track B (PROVIDER) are stored
-- in separate tables and must not be merged.
-- ============================================================

CREATE TABLE IF NOT EXISTS programs_client (
  program_id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Required fields (Track A)
  program_name TEXT NOT NULL,
  funding_track TEXT NOT NULL CHECK (funding_track IN ('CLIENT')),
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('Federal', 'State', 'County', 'Tribal')),
  state TEXT, -- 2-letter code, or NULL for federal-only, or 'DC'
  county TEXT,
  administering_agency TEXT,
  program_type TEXT, -- Waiver, Grant, Reimbursement, Benefit, Subsidy
  eligible_population TEXT,
  covered_services TEXT,
  income_limits TEXT,
  diagnosis_requirements TEXT,
  age_requirements TEXT,
  funding_amounts TEXT DEFAULT '[]', -- JSON array/object
  renewal_cycle TEXT,
  application_method TEXT,
  source_url TEXT NOT NULL,
  last_verified DATETIME,
  change_log TEXT DEFAULT '[]', -- JSON array of change summaries (lightweight)

  -- Operational fields
  is_active INTEGER DEFAULT 1,
  confidence REAL DEFAULT 0.0,
  canonical_key TEXT NOT NULL UNIQUE,
  source_url_hash TEXT,
  last_seen_at DATETIME,
  last_fetch_status INTEGER,
  last_content_hash TEXT
);

CREATE TABLE IF NOT EXISTS programs_provider (
  program_id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Required fields (Track B)
  program_name TEXT NOT NULL,
  funding_track TEXT NOT NULL CHECK (funding_track IN ('PROVIDER')),
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('Federal', 'State', 'County', 'Tribal')),
  state TEXT, -- 2-letter code, or NULL for federal-only, or 'DC'
  county TEXT,
  administering_agency TEXT,
  program_type TEXT, -- Waiver, Grant, Reimbursement, Benefit, Subsidy
  eligible_population TEXT,
  covered_services TEXT,
  income_limits TEXT,
  diagnosis_requirements TEXT,
  age_requirements TEXT,
  provider_requirements TEXT, -- Track B only
  funding_amounts TEXT DEFAULT '[]', -- JSON array/object
  renewal_cycle TEXT,
  application_method TEXT,
  source_url TEXT NOT NULL,
  last_verified DATETIME,
  change_log TEXT DEFAULT '[]', -- JSON array of change summaries (lightweight)

  -- Operational fields
  is_active INTEGER DEFAULT 1,
  confidence REAL DEFAULT 0.0,
  canonical_key TEXT NOT NULL UNIQUE,
  source_url_hash TEXT,
  last_seen_at DATETIME,
  last_fetch_status INTEGER,
  last_content_hash TEXT
);

-- Versioned snapshots (content change detection)
CREATE TABLE IF NOT EXISTS program_versions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  funding_track TEXT NOT NULL CHECK (funding_track IN ('CLIENT', 'PROVIDER')),
  program_id TEXT NOT NULL,

  source_url TEXT NOT NULL,
  fetched_at DATETIME,
  http_status INTEGER,
  content_type TEXT,
  content_hash TEXT,
  extracted_text TEXT, -- parsed plaintext (PHI-safe by design; do not store user data)
  normalized_payload TEXT NOT NULL, -- JSON snapshot of normalized fields
  change_type TEXT NOT NULL CHECK (change_type IN ('created', 'updated', 'unchanged', 'discontinued', 'reactivated', 'error')),
  changed_fields TEXT DEFAULT '[]', -- JSON array of field names
  change_summary TEXT, -- human-readable summary

  UNIQUE(funding_track, program_id, content_hash)
);

-- Linkable (but separate) datasets: cross-track relationships
CREATE TABLE IF NOT EXISTS program_crosslinks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  client_program_id TEXT REFERENCES programs_client(program_id) ON DELETE CASCADE,
  provider_program_id TEXT REFERENCES programs_provider(program_id) ON DELETE CASCADE,
  relationship_type TEXT, -- e.g. 'administered_by_same_agency', 'shares_eligibility', 'serves_as_provider_for'
  evidence_url TEXT,
  notes TEXT
);

-- Crawl targets for modular jurisdiction agents
CREATE TABLE IF NOT EXISTS program_crawl_targets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('Federal', 'State', 'County', 'Tribal')),
  state TEXT,
  base_url TEXT NOT NULL,
  seed_urls TEXT DEFAULT '[]', -- JSON array
  agent_id TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  parameters TEXT DEFAULT '{}'
);

-- Change event stream (notification-ready)
CREATE TABLE IF NOT EXISTS program_change_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  funding_track TEXT NOT NULL CHECK (funding_track IN ('CLIENT', 'PROVIDER')),
  program_id TEXT NOT NULL,
  version_id TEXT REFERENCES program_versions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'discontinued', 'reactivated')),
  changed_fields TEXT DEFAULT '[]',
  summary TEXT,
  confidence REAL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_programs_client_state ON programs_client(state);
CREATE INDEX IF NOT EXISTS idx_programs_client_jurisdiction ON programs_client(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_programs_client_active ON programs_client(is_active);
CREATE INDEX IF NOT EXISTS idx_programs_client_verified ON programs_client(last_verified);

CREATE INDEX IF NOT EXISTS idx_programs_provider_state ON programs_provider(state);
CREATE INDEX IF NOT EXISTS idx_programs_provider_jurisdiction ON programs_provider(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_programs_provider_active ON programs_provider(is_active);
CREATE INDEX IF NOT EXISTS idx_programs_provider_verified ON programs_provider(last_verified);

CREATE INDEX IF NOT EXISTS idx_program_versions_program ON program_versions(funding_track, program_id, created_at);
CREATE INDEX IF NOT EXISTS idx_program_versions_fetched ON program_versions(fetched_at);

CREATE INDEX IF NOT EXISTS idx_program_change_events_created ON program_change_events(created_at);
CREATE INDEX IF NOT EXISTS idx_program_change_events_program ON program_change_events(funding_track, program_id);

CREATE TRIGGER IF NOT EXISTS update_program_crawl_targets_timestamp
AFTER UPDATE ON program_crawl_targets
BEGIN
  UPDATE program_crawl_targets SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_program_crosslinks_timestamp
AFTER UPDATE ON program_crosslinks
BEGIN
  UPDATE program_crosslinks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- ============================================================
-- NATIONAL FUNDING & BENEFITS CRAWLER (V2) - STRICT SCHEMA
-- TRACK_A and TRACK_B are separate tables and must never be merged.
-- This is the schema used by crawler:smoke/crawler:doctor.
-- ============================================================

CREATE TABLE IF NOT EXISTS crawler_sources (
  source_id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('federal', 'state', 'county', 'tribal', 'mco', 'other')),
  state TEXT, -- 2-letter code if applicable (or 'DC')
  county TEXT,
  source_family TEXT NOT NULL, -- e.g. 'agency_site', 'portal', 'pdf_index', 'mock'
  base_url TEXT,
  seed_urls TEXT NOT NULL DEFAULT '[]', -- JSON array
  enabled INTEGER DEFAULT 1,
  tags TEXT DEFAULT '[]', -- JSON array (smoke,state,national)
  configuration TEXT DEFAULT '{}' -- JSON (parser hints, auth=none, etc.)
);

CREATE INDEX IF NOT EXISTS idx_crawler_sources_enabled ON crawler_sources(enabled);
CREATE INDEX IF NOT EXISTS idx_crawler_sources_state ON crawler_sources(state);
CREATE INDEX IF NOT EXISTS idx_crawler_sources_jurisdiction ON crawler_sources(jurisdiction);

CREATE TABLE IF NOT EXISTS crawl_runs (
  crawl_run_id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  mode TEXT NOT NULL CHECK (mode IN ('SMOKE_MODE', 'STATE_MODE', 'NATIONAL_MODE')),
  scope TEXT DEFAULT '{}', -- JSON (states, sources, limits)

  sources_attempted INTEGER DEFAULT 0,
  sources_succeeded INTEGER DEFAULT 0,
  sources_failed INTEGER DEFAULT 0,

  programs_extracted INTEGER DEFAULT 0,
  programs_normalized INTEGER DEFAULT 0,
  programs_upserted INTEGER DEFAULT 0,
  versions_created INTEGER DEFAULT 0,

  failures_count INTEGER DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawl_runs_created ON crawl_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_status ON crawl_runs(status);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_mode ON crawl_runs(mode);

CREATE TABLE IF NOT EXISTS crawl_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  crawl_run_id TEXT NOT NULL REFERENCES crawl_runs(crawl_run_id) ON DELETE CASCADE,
  source_id TEXT REFERENCES crawler_sources(source_id) ON DELETE SET NULL,
  url TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'source_start',
    'source_success',
    'source_failure',
    'fetch_start',
    'fetch_success',
    'fetch_failure',
    'parse_success',
    'parse_failure',
    'normalize_success',
    'normalize_failure',
    'upsert_success',
    'upsert_failure'
  )),
  message TEXT,
  metadata TEXT DEFAULT '{}' -- JSON
);

CREATE INDEX IF NOT EXISTS idx_crawl_events_run ON crawl_events(crawl_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crawl_events_source ON crawl_events(source_id, created_at);

CREATE TABLE IF NOT EXISTS parse_failures (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  crawl_run_id TEXT NOT NULL REFERENCES crawl_runs(crawl_run_id) ON DELETE CASCADE,
  source_id TEXT REFERENCES crawler_sources(source_id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  failure_type TEXT NOT NULL, -- fetch_error | http_error | parse_error | normalize_error
  parser_name TEXT,
  http_status INTEGER,
  retry_count INTEGER DEFAULT 0,
  stack TEXT,
  message TEXT,
  metadata TEXT DEFAULT '{}' -- JSON
);

CREATE INDEX IF NOT EXISTS idx_parse_failures_run ON parse_failures(crawl_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_parse_failures_source ON parse_failures(source_id, created_at);

CREATE TABLE IF NOT EXISTS nf_programs_a (
  program_id TEXT PRIMARY KEY, -- deterministic stable id
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  program_name TEXT NOT NULL,
  funding_track TEXT NOT NULL CHECK (funding_track IN ('TRACK_A')),
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('federal', 'state', 'county', 'tribal', 'mco', 'other')),
  state TEXT,
  county TEXT,
  administering_agency TEXT,
  program_type TEXT NOT NULL CHECK (program_type IN ('waiver', 'grant', 'reimbursement', 'benefit', 'subsidy', 'other')),

  eligible_population TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  covered_services TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  income_limits TEXT, -- JSON (nullable)
  diagnosis_requirements TEXT, -- JSON (nullable)
  age_requirements TEXT, -- JSON (nullable)
  provider_requirements TEXT, -- must be NULL for Track A
  funding_amounts TEXT, -- JSON (nullable)
  renewal_cycle TEXT,
  application_method TEXT,
  application_url TEXT,
  source_url TEXT NOT NULL,

  source_last_crawled_at DATETIME,
  last_verified DATETIME,
  confidence_score REAL NOT NULL DEFAULT 0.0,

  change_log TEXT NOT NULL DEFAULT '[]', -- JSON array (version pointers/diffs)
  raw_source_refs TEXT NOT NULL DEFAULT '[]', -- JSON array ({url, hash})

  is_active INTEGER DEFAULT 1,
  last_fetch_status INTEGER,
  last_content_hash TEXT
);

CREATE TABLE IF NOT EXISTS nf_programs_b (
  program_id TEXT PRIMARY KEY, -- deterministic stable id
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  program_name TEXT NOT NULL,
  funding_track TEXT NOT NULL CHECK (funding_track IN ('TRACK_B')),
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('federal', 'state', 'county', 'tribal', 'mco', 'other')),
  state TEXT,
  county TEXT,
  administering_agency TEXT,
  program_type TEXT NOT NULL CHECK (program_type IN ('waiver', 'grant', 'reimbursement', 'benefit', 'subsidy', 'other')),

  eligible_population TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  covered_services TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  income_limits TEXT, -- JSON (nullable)
  diagnosis_requirements TEXT, -- JSON (nullable)
  age_requirements TEXT, -- JSON (nullable)
  provider_requirements TEXT, -- JSON (nullable) Track B only
  funding_amounts TEXT, -- JSON (nullable)
  renewal_cycle TEXT,
  application_method TEXT,
  application_url TEXT,
  source_url TEXT NOT NULL,

  source_last_crawled_at DATETIME,
  last_verified DATETIME,
  confidence_score REAL NOT NULL DEFAULT 0.0,

  change_log TEXT NOT NULL DEFAULT '[]', -- JSON array (version pointers/diffs)
  raw_source_refs TEXT NOT NULL DEFAULT '[]', -- JSON array ({url, hash})

  is_active INTEGER DEFAULT 1,
  last_fetch_status INTEGER,
  last_content_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_nf_a_state ON nf_programs_a(state);
CREATE INDEX IF NOT EXISTS idx_nf_a_jurisdiction ON nf_programs_a(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_nf_a_track ON nf_programs_a(funding_track);
CREATE INDEX IF NOT EXISTS idx_nf_a_program_type ON nf_programs_a(program_type);
CREATE INDEX IF NOT EXISTS idx_nf_a_verified ON nf_programs_a(last_verified);

CREATE INDEX IF NOT EXISTS idx_nf_b_state ON nf_programs_b(state);
CREATE INDEX IF NOT EXISTS idx_nf_b_jurisdiction ON nf_programs_b(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_nf_b_track ON nf_programs_b(funding_track);
CREATE INDEX IF NOT EXISTS idx_nf_b_program_type ON nf_programs_b(program_type);
CREATE INDEX IF NOT EXISTS idx_nf_b_verified ON nf_programs_b(last_verified);

CREATE TABLE IF NOT EXISTS nf_program_versions (
  version_id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  crawl_run_id TEXT REFERENCES crawl_runs(crawl_run_id) ON DELETE SET NULL,
  program_id TEXT NOT NULL,
  funding_track TEXT NOT NULL CHECK (funding_track IN ('TRACK_A', 'TRACK_B')),
  source_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at DATETIME,
  http_status INTEGER,
  content_type TEXT,
  parser_name TEXT,
  normalized_payload TEXT NOT NULL, -- JSON snapshot
  changed_fields TEXT NOT NULL DEFAULT '[]', -- JSON array
  change_type TEXT NOT NULL CHECK (change_type IN ('created', 'updated', 'unchanged', 'discontinued', 'reactivated', 'error')),
  diff_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_nf_versions_program ON nf_program_versions(program_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nf_versions_track ON nf_program_versions(funding_track, created_at);
CREATE INDEX IF NOT EXISTS idx_nf_versions_hash ON nf_program_versions(content_hash);

CREATE TABLE IF NOT EXISTS nf_crosslinks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  program_id_a TEXT REFERENCES nf_programs_a(program_id) ON DELETE CASCADE,
  program_id_b TEXT REFERENCES nf_programs_b(program_id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  evidence_url TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_nf_crosslinks_a ON nf_crosslinks(program_id_a);
CREATE INDEX IF NOT EXISTS idx_nf_crosslinks_b ON nf_crosslinks(program_id_b);

CREATE TRIGGER IF NOT EXISTS update_crawler_sources_timestamp
AFTER UPDATE ON crawler_sources
BEGIN
  UPDATE crawler_sources SET updated_at = CURRENT_TIMESTAMP WHERE source_id = NEW.source_id;
END;

CREATE TRIGGER IF NOT EXISTS update_nf_crosslinks_timestamp
AFTER UPDATE ON nf_crosslinks
BEGIN
  UPDATE nf_crosslinks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- ============================================================================
-- Anya Brain (Persistent State)
-- ============================================================================

-- Store learned patterns, user preferences, and contextual memory
CREATE TABLE IF NOT EXISTS anya_brain_memory (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- Memory scope: 'global' (system-wide), 'profile' (per-profile), 'user' (per-user)
  scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'profile', 'user')),
  scope_id TEXT, -- profile_id or user_id depending on scope
  
  -- Memory type: 'fact', 'preference', 'context', 'learned_pattern'
  memory_type TEXT NOT NULL CHECK(memory_type IN ('fact', 'preference', 'context', 'learned_pattern')),
  
  -- Memory key for quick lookup (e.g., 'user_timezone', 'preferred_grant_types')
  memory_key TEXT NOT NULL,
  
  -- Memory content as JSON
  content TEXT NOT NULL DEFAULT '{}',
  
  -- Confidence score (0.0 - 1.0) for learned patterns
  confidence REAL DEFAULT 1.0,
  
  -- Expiration for temporary memories (NULL = permanent)
  expires_at DATETIME,
  
  -- Source of the memory (e.g., 'user_input', 'observation', 'system')
  source TEXT DEFAULT 'system',
  
  -- Number of times this memory was accessed (for relevance ranking)
  access_count INTEGER DEFAULT 0,
  last_accessed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_anya_brain_scope ON anya_brain_memory(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_anya_brain_key ON anya_brain_memory(memory_key);
CREATE INDEX IF NOT EXISTS idx_anya_brain_type ON anya_brain_memory(memory_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_anya_brain_unique ON anya_brain_memory(scope, scope_id, memory_key);

-- Anya's tool usage tracking for learning optimal tool selection
CREATE TABLE IF NOT EXISTS anya_tool_usage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  tool_name TEXT NOT NULL,
  session_id TEXT REFERENCES anya_sessions(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  
  -- Input parameters (JSON)
  parameters TEXT DEFAULT '{}',
  
  -- Outcome
  success INTEGER DEFAULT 1,
  error_message TEXT,
  execution_time_ms INTEGER,
  
  -- User feedback (if any)
  user_rating INTEGER CHECK(user_rating IS NULL OR (user_rating >= 1 AND user_rating <= 5)),
  user_feedback TEXT
);

CREATE INDEX IF NOT EXISTS idx_anya_tool_usage_tool ON anya_tool_usage(tool_name);
CREATE INDEX IF NOT EXISTS idx_anya_tool_usage_session ON anya_tool_usage(session_id);

-- Anya's conversation context for maintaining coherent multi-turn conversations
CREATE TABLE IF NOT EXISTS anya_context (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  session_id TEXT NOT NULL REFERENCES anya_sessions(id) ON DELETE CASCADE,
  
  -- Context type: 'topic', 'entity', 'intent', 'goal'
  context_type TEXT NOT NULL CHECK(context_type IN ('topic', 'entity', 'intent', 'goal')),
  
  -- Context value
  context_value TEXT NOT NULL,
  
  -- Relevance score (decays over time)
  relevance REAL DEFAULT 1.0,
  
  -- Turn number when this context was established
  turn_number INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_anya_context_session ON anya_context(session_id);

CREATE TRIGGER IF NOT EXISTS update_anya_brain_timestamp
AFTER UPDATE ON anya_brain_memory
BEGIN
  UPDATE anya_brain_memory SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Service Applications (from website contact/apply forms)
CREATE TABLE IF NOT EXISTS service_applications (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- Application type: 'service_application', 'contact_admin'
  type TEXT NOT NULL DEFAULT 'service_application',
  
  -- Applicant info
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  organization TEXT,
  title TEXT,
  
  -- Service details
  client_category TEXT,
  selected_services TEXT DEFAULT '[]', -- JSON array
  total_cost REAL,
  
  -- For contact forms
  subject TEXT,
  message TEXT,
  
  -- Status tracking
  status TEXT DEFAULT 'new' CHECK(status IN ('new', 'reviewed', 'contacted', 'converted', 'archived')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at DATETIME,
  notes TEXT,
  
  -- Link to created profile (if converted)
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_service_applications_status ON service_applications(status);
CREATE INDEX IF NOT EXISTS idx_service_applications_created ON service_applications(created_at);
CREATE INDEX IF NOT EXISTS idx_service_applications_email ON service_applications(email);