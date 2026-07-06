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
  notes TEXT,
  deleted_at DATETIME
);

-- Funding Opportunities (master list of available grants)
-- vNext backbone: funders + form_schemas are created before opportunities so FKs are valid.
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

CREATE TABLE IF NOT EXISTS funding_opportunities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  title TEXT NOT NULL,
  sponsor TEXT,
  source TEXT, -- 'grants.gov', 'foundation', 'state', 'federal', etc.
  source_id TEXT, -- external ID from source
  source_url TEXT,
  record_origin TEXT DEFAULT 'live_crawl' CHECK(record_origin IN ('live_crawl','curated_verified','curated_benefits','curated_program','curated_catalog','scholarship_crawler','school_portal','grants_gov','verified_real','cof_foundation_locator','manual','synthetic','funding_api','clinical_trials','url_import','directory_resource','directory:health_resources','directory:student_grants','discovered','geo_crawl','web_search','seeded','imported')),
  
  description TEXT,
  eligibility_bullets TEXT DEFAULT '[]', -- JSON array
  
  amount_min REAL,
  amount_max REAL,
  amount_description TEXT,
  -- Best-available amount TEXT + explicit status when no per-award number is
  -- knowable (awardAmountExtractor.js): a row is never silently blank.
  amount_text TEXT,
  amount_status TEXT CHECK(amount_status IN ('known','estimated','range','varies','not_listed','contact_required')),
  amount_confidence REAL,

  deadline DATE,
  deadline_type TEXT CHECK(deadline_type IN ('fixed', 'rolling', 'ongoing', 'unknown')),
  
  application_url TEXT,
  -- vNext canonical apply links (keep legacy application_url for compatibility)
  apply_url TEXT,
  apply_guidelines_url TEXT,
  application_mode TEXT CHECK(application_mode IN ('portal','email','paper','unknown')),
  
  -- Contact information (JSON: { name, email, phone, address, website })
  contact_info TEXT DEFAULT NULL,

  -- vNext schema authority + canonical funder link
  funder_id TEXT REFERENCES funders(id) ON DELETE SET NULL,
  schema_id TEXT REFERENCES form_schemas(id) ON DELETE SET NULL,
  
  -- Geographic
  is_national BOOLEAN DEFAULT FALSE,
  state TEXT,
  -- Geo Crawl tagging (durable run tracking)
  geo_run_id TEXT,
  geo_zip TEXT,
  geo_county TEXT,
  geo_source TEXT,
  geo_scope TEXT,
  regions TEXT DEFAULT '[]', -- JSON array
  
  -- Categories
  categories TEXT DEFAULT '[]', -- JSON array
  keywords TEXT DEFAULT '[]', -- JSON array
  opportunity_type TEXT, -- 'grant', 'scholarship', 'loan', 'benefit', etc.
  funding_type TEXT,
  type TEXT DEFAULT 'OPPORTUNITY' CHECK(type IN ('OPPORTUNITY', 'PROGRAM', 'DIRECTORY')),
  evidence_url TEXT, -- URL used to verify this opportunity
  -- Discovery vs verification are tracked separately.
  -- discovered_at = first time GrantFlow ingested this row.
  -- last_verified_at = last time the URL was actually probed by linkVerificationService
  --                    or a crawler that performed a real HEAD/GET. Crawlers are NOT
  --                    allowed to stamp this without a network check.
  discovered_at DATETIME,
  last_verified_at DATETIME,
  -- 'unverified' (never checked) | 'ok' | 'redirect' | 'broken' | 'skipped' | 'unknown'
  link_status TEXT DEFAULT 'unverified',
  link_status_code INTEGER,
  -- 'head' | 'get' | 'manual' | 'crawler:<name>' | NULL when never verified
  verification_method TEXT,
  verified_by TEXT,
  verification_error TEXT,
  -- Reality gate classification (migration 068).
  --   opportunity_kind: 'direct' | 'benefit' | 'directory' | 'referral' | 'school_portal'
  --   source_trust_tier: 'official_api' | 'official_portal' | 'verified_directory' |
  --                      'community_directory' | 'open_web' | 'manual_curated'
  opportunity_kind TEXT,
  source_trust_tier TEXT,
  -- Persisted reality-gate verdict (migration 077 / RC-8).
  --   reality_status: 'allowed' | 'rejected' | 'downgraded' | NULL (unknown / pre-RC8)
  --   reality_reasons: JSON array of policy reason codes from assessReality().
  --   final_url: URL after redirects (proven landing page).
  --   http_status: HTTP status code from the last live probe.
  reality_status TEXT,
  reality_reasons TEXT,
  final_url TEXT,
  http_status INTEGER,
  -- result_kind separates "real grant a user can apply for" from
  -- "directory/referral the user can call/search". Drives UI badge + the
  -- broken-link hide rule (broken direct → hide; broken directory → label).
  result_kind TEXT,           -- direct | benefit | directory | school_portal | action_step
  is_hidden INTEGER DEFAULT 0,


  -- Requirements
  requires_501c3 BOOLEAN DEFAULT FALSE,
  requires_match BOOLEAN DEFAULT FALSE,
  match_percentage REAL,
  match_reasons TEXT DEFAULT '[]', -- JSON array of match/eligibility reasons
  
  -- Loan / matching fund flag
  is_loan BOOLEAN DEFAULT FALSE,

  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  last_crawled DATETIME,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','expired')),
  fingerprint TEXT,
  last_seen_at DATETIME,
  deadline_at DATETIME,
  
  -- For tracking which profiles this was matched to
  profile_id TEXT,

  -- Misc
  notes TEXT,

  -- Domain corpus metadata (National Funding Aggregator)
  funding_domain TEXT,
  funding_subdomain TEXT,
  source_category TEXT,
  compliance_required TEXT DEFAULT '[]',
  certifications_required TEXT DEFAULT '[]',
  geo_eligibility TEXT,
  signal_tags TEXT DEFAULT '[]',
  verified_url INTEGER DEFAULT 0,
  crawler_version TEXT,

  -- Housing-aware classification (migration 054)
  -- funding_category values: tuition_only | refund_eligible | stipend | housing_direct | faith_based | talent_based | coa_adjustment
  funding_category TEXT,
  usable_for_housing INTEGER DEFAULT 0,
  refund_potential INTEGER DEFAULT 0,
  -- eligibility_signals: JSON object { gpa_min, faith_affiliation, talent_type, state, field_of_study }
  eligibility_signals TEXT DEFAULT '{}',
  -- verification_status: verified_live_url | suspected_dead | needs_review
  verification_status TEXT DEFAULT 'needs_review',
  -- Source classification (migration 055 folded into schema for fresh-boot DBs)
  -- funding_source_type values: federal | state | foundation | corporate | university | medical | community | other
  funding_source_type TEXT,
  -- Raw payload captured from upstream source (ingestion pipeline)
  raw_source_payload TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_funding_opportunities_fingerprint
  ON funding_opportunities(fingerprint)
  WHERE fingerprint IS NOT NULL AND TRIM(fingerprint) <> '';
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_funder_id ON funding_opportunities(funder_id);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_schema_id ON funding_opportunities(schema_id);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_status ON funding_opportunities(status);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_opportunity_kind
  ON funding_opportunities(opportunity_kind);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_source_trust_tier
  ON funding_opportunities(source_trust_tier);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_reality_status
  ON funding_opportunities(reality_status);

-- Append-only audit log of every URL verification probe (migration 069).
-- Lets the mission dashboard answer "when was this opportunity actually
-- probed?" and "what's the broken-link rate per source?" without scraping
-- application logs. We never UPDATE this table; we only INSERT.
CREATE TABLE IF NOT EXISTS verification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT,
  source TEXT,
  url TEXT,
  link_status TEXT,
  link_status_code INTEGER,
  verification_method TEXT,
  verified_by TEXT,
  verification_error TEXT,
  duration_ms INTEGER,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_verification_events_opportunity_id
  ON verification_events(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_verification_events_ts
  ON verification_events(ts);
CREATE INDEX IF NOT EXISTS idx_verification_events_status
  ON verification_events(link_status);

-- Per-result evidence snippets (ingestion provenance & quality layer).
-- Every stored opportunity should carry the evidence that justifies it: the
-- snippet(s) of source text (title + matched description / eligibility text)
-- and the source URL it came from. Captured at ingest time from the live
-- search adapters (which already carry title/description/snippet/url). One
-- opportunity may have several evidence rows (title, description, eligibility).
-- evidence_type values: 'title' | 'description' | 'eligibility' | 'snippet'
CREATE TABLE IF NOT EXISTS opportunity_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT NOT NULL,
  source_url TEXT,
  snippet TEXT,
  evidence_type TEXT,
  crawl_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_opportunity_evidence_opportunity_id
  ON opportunity_evidence(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_evidence_crawl_ts
  ON opportunity_evidence(crawl_timestamp);

-- Semantic-recall embeddings sidecar (SEMANTIC_RECALL feature, default OFF).
-- One vector per catalog row, stored as JSON text; cosine similarity is
-- computed in JS over a bounded scan (Postgres may add a pgvector column via
-- migration 0135). Embeddings only ADD candidates into the canonical
-- matcher's scan — matchEngine remains the sole scoring/decision authority.
CREATE TABLE IF NOT EXISTS opportunity_embeddings (
  opportunity_id TEXT PRIMARY KEY REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_opportunity_embeddings_updated
  ON opportunity_embeddings(updated_at);

-- Rejection log (ingestion provenance & quality layer).
-- Today the ingest gates (policy / validation / reviewer / reality / quality /
-- provenance) reject rows but only console.warn. This append-only log makes
-- "why was this excluded?" visible to admins. Writes are best-effort and must
-- never block or throw the ingest path.
-- stage values: 'policy' | 'validation' | 'reviewer' | 'reality' | 'quality' |
--               'provenance' | 'dedupe' | 'url' | 'ingest'
-- reason is a structured code, e.g. dead_application_url, placeholder_content,
--   loan_like, expired_deadline, untrusted_origin, unknown_source, duplicate,
--   quality:<x>, policy:<x>, validation:<x>, reviewer:<x>, reality:<x>
CREATE TABLE IF NOT EXISTS rejection_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  source_url TEXT,
  title TEXT,
  reason TEXT,
  stage TEXT,
  raw_meta TEXT, -- JSON
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rejection_log_checked_at
  ON rejection_log(checked_at);
CREATE INDEX IF NOT EXISTS idx_rejection_log_stage
  ON rejection_log(stage);
CREATE INDEX IF NOT EXISTS idx_rejection_log_source
  ON rejection_log(source);

-- Item catalog (AI + deterministic suggestions)
-- A durable list of "things people request" (devices, equipment, adaptive items, etc.)
CREATE TABLE IF NOT EXISTS item_catalog (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  active BOOLEAN DEFAULT TRUE,
  name TEXT NOT NULL,
  category TEXT,
  synonyms TEXT DEFAULT '[]', -- JSON array
  tags TEXT DEFAULT '[]', -- JSON array
  source TEXT DEFAULT 'curated' CHECK(source IN ('curated', 'anya_discovered', 'manual')),
  evidence_url TEXT,
  notes TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_item_catalog_name ON item_catalog(name);
CREATE INDEX IF NOT EXISTS idx_item_catalog_active ON item_catalog(active);

-- Geo Crawl run tracking (durable progress for live monitor)
CREATE TABLE IF NOT EXISTS geo_crawl_runs (
  id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','failed','complete')),
  state TEXT,
  current_zip TEXT,
  current_county TEXT,
  current_source TEXT,
  processed_zip_count INTEGER DEFAULT 0,
  found_opportunity_count INTEGER DEFAULT 0,
  last_heartbeat_at DATETIME,
  last_error TEXT,
  crawler_job_id TEXT REFERENCES crawler_jobs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS geo_crawl_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES geo_crawl_runs(id) ON DELETE CASCADE,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error')),
  state TEXT,
  zip TEXT,
  county TEXT,
  source TEXT,
  message TEXT,
  found_count_delta INTEGER DEFAULT 0
);

-- Geo Crawl association index (opportunity_id can appear in many runs/zips)
CREATE TABLE IF NOT EXISTS funding_opportunity_geo_index (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  geo_run_id TEXT,
  state TEXT,
  zip TEXT,
  county TEXT,
  source TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_fo_geo_index
  ON funding_opportunity_geo_index(opportunity_id, geo_run_id, state, zip, source);

CREATE INDEX IF NOT EXISTS idx_fo_geo_index_run_id
  ON funding_opportunity_geo_index(geo_run_id);

CREATE INDEX IF NOT EXISTS idx_fo_geo_index_zip
  ON funding_opportunity_geo_index(zip);

-- Geographic coverage cache: precomputed nearby-ZIP relationships per profile ZIP.
-- Used by geoCoverageService for radius-based progressive expansion.
CREATE TABLE IF NOT EXISTS geo_zip_coverage (
  center_zip TEXT NOT NULL,
  nearby_zip TEXT NOT NULL,
  distance_miles REAL NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('local','expanded')),
  state TEXT,
  PRIMARY KEY (center_zip, nearby_zip)
);

CREATE INDEX IF NOT EXISTS idx_gzc_center ON geo_zip_coverage(center_zip);
CREATE INDEX IF NOT EXISTS idx_gzc_nearby ON geo_zip_coverage(nearby_zip);
CREATE INDEX IF NOT EXISTS idx_gzc_tier ON geo_zip_coverage(center_zip, tier);

-- Grants (opportunities being actively tracked/pursued)
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  funding_opportunity_id TEXT REFERENCES funding_opportunities(id),
  
  title TEXT NOT NULL,
  funder TEXT,
  
  amount_requested REAL,
  amount_awarded REAL,
  amount_min REAL,
  amount_max REAL,
  -- Mirrored from the linked catalog row by enforceGrantAmountBackfill() so
  -- pipeline cards can show honest "varies / contact funder / not listed"
  -- states instead of a blank when no dollar figure is knowable.
  amount_text TEXT,
  amount_status TEXT CHECK(amount_status IN ('known','estimated','range','varies','not_listed','contact_required')),
  amount_confidence REAL,

  status TEXT DEFAULT 'discovered' CHECK(status IN (
        -- Canonical pipeline (RC-13, shared/pipelineStages.js):
        'discovered', 'saved', 'interested', 'gathering_documents',
        'drafting', 'ready_to_submit', 'submitted', 'follow_up',
        'awarded', 'declined', 'archived',
        -- Legacy stage names preserved so pre-RC-13 rows stay valid:
        'discovery', 'auto_applied', 'application_prep', 'revision',
        'portal', 'pending_review', 'report', 'declined_no_review',
        'closed', 'app_prep', 'under_review', 'rejected',
        'deadline_passed'
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

  -- Application guidance (AI/deterministic advisor)
  application_method TEXT,
  application_steps TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  funder_fax TEXT,
  funder_address TEXT,

  -- Match decision metadata (canonical from matchEngine.js)
  match_decision TEXT,
  match_explanation JSONB,
  matched_needs JSONB DEFAULT '[]',
  eligibility_status TEXT,
  ineligibility_reasons TEXT DEFAULT '[]',
  profile_fingerprint TEXT,
  opportunity_fingerprint TEXT,
  matcher_version TEXT,
  evaluated_at DATETIME,
  match_confidence INTEGER,

  -- Canonical URL + content fingerprint (migration 058).
  -- url stores the authoritative actionable URL chosen for this grant
  -- (distinct from application_url/portal_url fallbacks). fingerprint is
  -- sha256(title|sponsor|deadline|source_url) for dedup + drift detection.
  url TEXT,
  fingerprint TEXT,
  fingerprint_version INTEGER DEFAULT 1,

  -- Tracking
  assigned_to TEXT,
  priority TEXT CHECK(priority IN ('low', 'medium', 'high', 'urgent'))
);

CREATE INDEX IF NOT EXISTS idx_grants_fingerprint ON grants(fingerprint);
CREATE INDEX IF NOT EXISTS idx_grants_url         ON grants(url);

-- crawler_logs: audit trail for both profile-scoped and global crawl runs.
-- opportunityMatcher.trackGlobalOpportunity and codeGuard goal 11 both
-- require this table; its absence was breaking silent inserts and the
-- mission verifier.
CREATE TABLE IF NOT EXISTS crawler_logs (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_id       TEXT REFERENCES crawler_jobs(id) ON DELETE CASCADE,
  profile_id   TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  crawler_type TEXT,
  level        TEXT,
  status       TEXT,
  message      TEXT,
  payload      TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crawler_logs_job        ON crawler_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_profile    ON crawler_logs(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_created_at ON crawler_logs(created_at);

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

-- vNext applications (deterministic state machine execution unit)
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

  risk_score REAL,
  expected_value REAL,
  score_breakdown TEXT,        -- JSON
  missing_requirements TEXT,   -- JSON

  UNIQUE(profile_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_vnext_applications_profile_id ON vnext_applications(profile_id);
CREATE INDEX IF NOT EXISTS idx_vnext_applications_opportunity_id ON vnext_applications(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_vnext_applications_state ON vnext_applications(state);

CREATE TABLE IF NOT EXISTS vnext_application_tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  application_id TEXT NOT NULL REFERENCES vnext_applications(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
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

-- Documents
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id TEXT REFERENCES grants(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  
  -- Optional: link a document to a specific university application entry within the profile
  -- (used for acceptance letters, scholarship letters, housing forms, etc.)
  university_application_id TEXT,
  university_application_name TEXT,
  
  name TEXT NOT NULL,
  type TEXT, -- 'proposal', 'budget', 'letter_of_support', 'form', 'report', etc.
  
  file_url TEXT,
  file_path TEXT,
  file_size INTEGER,
  mime_type TEXT,
  extracted_text TEXT,
  extracted_structured TEXT, -- JSON (vNext mapping)
  ai_summary TEXT,
  ai_sections TEXT,
  processing_status TEXT DEFAULT 'pending' CHECK(processing_status IN ('pending', 'processing', 'completed', 'failed')),
  processing_error TEXT,
  
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'review', 'final', 'submitted')),
  version INTEGER DEFAULT 1,

  -- vNext linkages (optional)
  vnext_application_id TEXT REFERENCES vnext_applications(id) ON DELETE SET NULL,
  storage_uri TEXT,
  content_hash TEXT,
  
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_vnext_app ON documents(vnext_application_id);
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);

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
  avatar_data BLOB,
  avatar_content_type TEXT,
  is_admin BOOLEAN DEFAULT 0,
  password_hash TEXT,
  metadata TEXT,
  -- Stamped on every successful sign-in (session mint). NULL = never signed
  -- in; the NULL->set transition fires the one-time "new user first login"
  -- owner notification (services/firstLoginNotifier.js).
  last_login_at DATETIME
);

-- saved_grants: profile-scoped favorites/bookmarks. Each user can save the
-- same opportunity independently under each of their profiles. Legacy rows
-- created before migration 075 keep profile_id=NULL and are visible to all
-- of that user's profiles (read-only fallback). New saves always carry a
-- non-null profile_id.
CREATE TABLE IF NOT EXISTS saved_grants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL,
  saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT DEFAULT NULL
);
-- Per-profile uniqueness for new saves; partial so legacy NULL rows are
-- preserved and don't conflict.
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_profile_opp
  ON saved_grants(user_id, profile_id, opportunity_id)
  WHERE profile_id IS NOT NULL;
-- Legacy uniqueness: at most one NULL-profile row per (user, opportunity).
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_legacy_opp
  ON saved_grants(user_id, opportunity_id)
  WHERE profile_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_saved_grants_user_id ON saved_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_grants_opportunity_id ON saved_grants(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_saved_grants_profile_id ON saved_grants(profile_id);

-- vNext fine-grained audit events (before/after snapshots for state transitions, tasks, scoring, etc.)
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

-- Many-to-many user ↔ organization membership (used by admin tooling and access control).
CREATE TABLE IF NOT EXISTS user_organizations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_user_organizations_org ON user_organizations(organization_id);

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

-- One-time password setup tokens (first-login password setup via emailed link).
CREATE TABLE IF NOT EXISTS password_setup_tokens (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME,
  request_ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_token_hash ON password_setup_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user_id ON password_setup_tokens(user_id);

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

-- Runtime secrets (encrypted values persisted in DB for emergency overrides)
-- NOTE: values are encrypted server-side; the DB never stores plaintext secrets.
CREATE TABLE IF NOT EXISTS app_runtime_secrets (
  key TEXT PRIMARY KEY,
  value_ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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

-- Contact Methods (normalized email/phone arrays per organization)
CREATE TABLE IF NOT EXISTS contact_methods (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  type TEXT NOT NULL CHECK(type IN ('email', 'phone')),
  value TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0,

  created_by TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_contact_methods_org ON contact_methods(organization_id);
CREATE INDEX IF NOT EXISTS idx_contact_methods_type ON contact_methods(type);
CREATE INDEX IF NOT EXISTS idx_contact_methods_primary ON contact_methods(is_primary);

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
  ),
  (
    'individual',
    'Individual',
    'Individuals/families seeking assistance.',
    0,
    8500,
    0,
    1,
    1
  ),
  (
    'small_org',
    'Small Org',
    'Annual budget under $250,000.',
    0,
    8500,
    0,
    1,
    1
  ),
  (
    'mid_size',
    'Mid-Size',
    'Annual budget $250,000 - $2,000,000.',
    0,
    11500,
    1,
    1,
    1
  ),
  (
    'large_org',
    'Large Org',
    'Annual budget over $2,000,000.',
    0,
    15000,
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
  -- Chosen language for this profile (short code, e.g. 'ru', 'es'). NULL/'en'
  -- means English-only. Drives the global bilingual-documents rule: Hamilton
  -- packets are saved in English AND, when non-English, a translated copy.
  preferred_language TEXT,
  -- Timestamp of the most recent discovery RUN for this profile. NULL until
  -- discovery has ever been triggered. The matching endpoint uses this as a
  -- gate: NOTHING is shown from the global catalog until discovery has run
  -- for the profile (so a fresh profile doesn't surface pre-loaded results).
  last_discovery_at DATETIME,
  avatar_url TEXT,
  -- Durable avatar storage: the image bytes live in the DB so the avatar
  -- survives an ephemeral /uploads wipe (see migration 096 / pg 0092). Declared
  -- in the base schema too so smoke-mode / fresh sqlite has parity with prod and
  -- the DB-backed download path is exercised rather than silently skipped.
  avatar_data BLOB,
  avatar_content_type TEXT
);

-- Tombstones for hard-deleted profiles.
-- Prevents startup seeding/ensure logic from resurrecting removed profiles.
CREATE TABLE IF NOT EXISTS profile_tombstones (
  profile_id TEXT PRIMARY KEY,
  deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_by TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_profile_tombstones_deleted_at ON profile_tombstones(deleted_at);

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

-- School-portal bridge — see docs/school-portal-integration.md.
-- Lets a registered school's student-information system (Banner / Workday /
-- PeopleSoft / Slate / Anthology Apply) push student records into GrantFlow
-- profiles and read back funding sources the matcher says they're eligible for.
CREATE TABLE IF NOT EXISTS school_partners (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ein TEXT,
  ipeds_id TEXT,
  contact_name TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','suspended','revoked')),
  allowed_origins TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_school_partners_status ON school_partners(status);
CREATE INDEX IF NOT EXISTS idx_school_partners_slug   ON school_partners(slug);

CREATE TABLE IF NOT EXISTS school_partner_api_keys (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  school_partner_id TEXT NOT NULL
    REFERENCES school_partners(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  label TEXT,
  created_by TEXT,
  last_used_at DATETIME,
  expires_at DATETIME,
  revoked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_school_partner_api_keys_partner
  ON school_partner_api_keys(school_partner_id);
CREATE INDEX IF NOT EXISTS idx_school_partner_api_keys_hash
  ON school_partner_api_keys(key_hash);

CREATE TABLE IF NOT EXISTS school_student_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  school_partner_id TEXT NOT NULL
    REFERENCES school_partners(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  external_student_id TEXT NOT NULL,
  email TEXT,
  consent_status TEXT NOT NULL DEFAULT 'granted'
    CHECK(consent_status IN ('pending','granted','revoked')),
  consented_at DATETIME,
  revoked_at DATETIME,
  last_synced_at DATETIME,
  last_sync_payload_hash TEXT,
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(school_partner_id, external_student_id)
);
CREATE INDEX IF NOT EXISTS idx_school_student_links_profile
  ON school_student_links(profile_id);
CREATE INDEX IF NOT EXISTS idx_school_student_links_email
  ON school_student_links(email);
CREATE INDEX IF NOT EXISTS idx_school_student_links_consent
  ON school_student_links(consent_status);

-- Robert — funding-discovery agent persistent state. See
-- docs/ROBERT_FUNDING_DISCOVERY_AGENT.md. Robert delegates scoring,
-- policy, validation, ingestion, and matching to canonical services;
-- these tables only track Robert's own discovery + recommendation queue.
CREATE TABLE IF NOT EXISTS robert_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL DEFAULT 'observe',
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  profiles_considered INTEGER DEFAULT 0,
  sources_considered INTEGER DEFAULT 0,
  urls_fetched INTEGER DEFAULT 0,
  candidates_found INTEGER DEFAULT 0,
  candidates_verified INTEGER DEFAULT 0,
  opportunities_ingested INTEGER DEFAULT 0,
  opportunities_matched INTEGER DEFAULT 0,
  recommendations_created INTEGER DEFAULT 0,
  recommendations_delivered INTEGER DEFAULT 0,
  recommendations_accepted INTEGER DEFAULT 0,
  recommendations_declined INTEGER DEFAULT 0,
  zero_result_profiles_helped INTEGER DEFAULT 0,
  summary_json TEXT DEFAULT '{}',
  error TEXT,
  created_by_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_robert_runs_started_at ON robert_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_robert_runs_status     ON robert_runs(status);
CREATE INDEX IF NOT EXISTS idx_robert_runs_mode       ON robert_runs(mode);

-- Sam — production-readiness agent run history. See
-- docs/SAM_PRODUCTION_AGENT.md for design notes. Sam orchestrates the
-- existing Anya autonomous tooling and project release gates; this table
-- records each orchestrating run alongside per-tool history in `anya_runs`.
CREATE TABLE IF NOT EXISTS sam_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL DEFAULT 'observe',
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  health_score REAL,
  production_ready INTEGER,
  summary_json TEXT DEFAULT '{}',
  findings_json TEXT DEFAULT '[]',
  repair_plan_json TEXT DEFAULT '[]',
  applied_fixes_json TEXT DEFAULT '[]',
  error TEXT,
  created_by_user_id TEXT
);

-- Sam's audit findings (read by the Mission Control aggregators + health check).
CREATE TABLE IF NOT EXISTS sam_findings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  sam_run_id TEXT,
  severity TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  event_type TEXT,
  title TEXT,
  description TEXT,
  file_path TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Yana's downstream hand-off queues (qualified leads forwarded to John).
-- Note: a separate `yana_larry_queue` table exists for backward compatibility
-- with the legacy Yana lead pipeline.
CREATE TABLE IF NOT EXISTS yana_john_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lead_candidate_id TEXT,
  organization_id TEXT,
  profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  processed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS yana_larry_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lead_candidate_id TEXT,
  organization_id TEXT,
  profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  processed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS robert_source_candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_domain TEXT,
  source_type TEXT,
  source_scope TEXT,
  geography_state TEXT,
  geography_county TEXT,
  geography_city TEXT,
  applicant_types_json TEXT DEFAULT '[]',
  need_categories_json TEXT DEFAULT '[]',
  trust_score INTEGER DEFAULT 0,
  discovered_by TEXT,
  discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_checked_at DATETIME,
  status TEXT NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  evidence_json TEXT DEFAULT '{}',
  robots_allowed INTEGER DEFAULT 1,
  rate_limit_bucket TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_robert_source_candidates_url ON robert_source_candidates(source_url);
CREATE INDEX IF NOT EXISTS idx_robert_source_candidates_status ON robert_source_candidates(status);
CREATE INDEX IF NOT EXISTS idx_robert_source_candidates_domain ON robert_source_candidates(source_domain);

CREATE TABLE IF NOT EXISTS robert_opportunity_candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT,
  source_candidate_id TEXT,
  title TEXT,
  sponsor TEXT,
  description TEXT,
  application_url TEXT,
  source_url TEXT,
  deadline TEXT,
  deadline_type TEXT,
  amount_min REAL,
  amount_max REAL,
  amount_description TEXT,
  geography_json TEXT DEFAULT '{}',
  eligibility_json TEXT DEFAULT '[]',
  categories_json TEXT DEFAULT '[]',
  keywords_json TEXT DEFAULT '[]',
  applicant_types_json TEXT DEFAULT '[]',
  need_categories_json TEXT DEFAULT '[]',
  raw_payload_json TEXT DEFAULT '{}',
  extraction_method TEXT,
  confidence REAL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verification_reasons_json TEXT DEFAULT '[]',
  policy_status TEXT,
  policy_rejection_reason TEXT,
  reality_status TEXT,
  reviewer_status TEXT,
  normalized_opportunity_json TEXT,
  existing_opportunity_id TEXT,
  ingested_opportunity_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_robert_oc_run            ON robert_opportunity_candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_robert_oc_source         ON robert_opportunity_candidates(source_candidate_id);
CREATE INDEX IF NOT EXISTS idx_robert_oc_verification   ON robert_opportunity_candidates(verification_status);
CREATE INDEX IF NOT EXISTS idx_robert_oc_app_url        ON robert_opportunity_candidates(application_url);
CREATE INDEX IF NOT EXISTS idx_robert_oc_source_url     ON robert_opportunity_candidates(source_url);

CREATE TABLE IF NOT EXISTS robert_profile_coverage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  coverage_score REAL DEFAULT 0,
  known_matches_count INTEGER DEFAULT 0,
  accepted_matches_count INTEGER DEFAULT 0,
  review_matches_count INTEGER DEFAULT 0,
  zero_result_risk INTEGER DEFAULT 0,
  missing_need_categories_json TEXT DEFAULT '[]',
  missing_geographies_json TEXT DEFAULT '[]',
  recommended_search_queries_json TEXT DEFAULT '[]',
  recommended_source_types_json TEXT DEFAULT '[]',
  last_analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_robert_profile_coverage_profile ON robert_profile_coverage(profile_id);

CREATE TABLE IF NOT EXISTS robert_profile_recommendations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT,
  robert_run_id TEXT,
  recommendation_status TEXT NOT NULL DEFAULT 'pending',
  delivery_status TEXT NOT NULL DEFAULT 'queued',
  match_score REAL,
  match_decision TEXT,
  match_reasons_json TEXT DEFAULT '[]',
  missing_profile_fields_json TEXT DEFAULT '[]',
  why_found TEXT,
  search_query_used TEXT,
  source_candidate_id TEXT,
  opportunity_candidate_id TEXT,
  toast_title TEXT,
  toast_body TEXT,
  toast_priority TEXT DEFAULT 'normal',
  toast_shown_at DATETIME,
  viewed_at DATETIME,
  accepted_at DATETIME,
  declined_at DATETIME,
  last_delivered_at DATETIME,
  delivery_attempts INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_robert_recommendations_profile_opp_active
  ON robert_profile_recommendations(profile_id, opportunity_id)
  WHERE recommendation_status IN ('pending','delivered','viewed');
CREATE INDEX IF NOT EXISTS idx_robert_recommendations_profile     ON robert_profile_recommendations(profile_id);
CREATE INDEX IF NOT EXISTS idx_robert_recommendations_opportunity ON robert_profile_recommendations(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_robert_recommendations_status      ON robert_profile_recommendations(recommendation_status);
CREATE INDEX IF NOT EXISTS idx_robert_recommendations_delivery    ON robert_profile_recommendations(delivery_status);
CREATE INDEX IF NOT EXISTS idx_robert_recommendations_created     ON robert_profile_recommendations(created_at DESC);

CREATE TABLE IF NOT EXISTS robert_domain_rate_limits (
  domain TEXT PRIMARY KEY,
  window_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  request_count INTEGER DEFAULT 0,
  last_request_at DATETIME,
  blocked_until DATETIME,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_robert_rate_limits_blocked ON robert_domain_rate_limits(blocked_until);

CREATE INDEX IF NOT EXISTS idx_sam_runs_started_at ON sam_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sam_runs_status     ON sam_runs(status);
CREATE INDEX IF NOT EXISTS idx_sam_runs_mode       ON sam_runs(mode);
CREATE INDEX IF NOT EXISTS idx_sam_runs_user       ON sam_runs(created_by_user_id);

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
CREATE INDEX IF NOT EXISTS idx_grants_profile_id ON grants(profile_id);
-- Idempotency: a profile should never get the same opportunity twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_profile_opportunity
  ON grants(profile_id, funding_opportunity_id)
  WHERE profile_id IS NOT NULL AND funding_opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grants_status ON grants(status);
CREATE INDEX IF NOT EXISTS idx_grants_deadline ON grants(deadline);
CREATE INDEX IF NOT EXISTS idx_opportunities_deadline ON funding_opportunities(deadline);
CREATE INDEX IF NOT EXISTS idx_opportunities_is_active ON funding_opportunities(is_active);
CREATE INDEX IF NOT EXISTS idx_opportunities_state ON funding_opportunities(state);
CREATE INDEX IF NOT EXISTS idx_fo_record_origin_active ON funding_opportunities(record_origin, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fo_source_source_id ON funding_opportunities(source, source_id);
CREATE INDEX IF NOT EXISTS idx_fo_is_loan ON funding_opportunities(is_loan);
CREATE INDEX IF NOT EXISTS idx_fo_state_active_deadline ON funding_opportunities(state, is_active, deadline);
CREATE INDEX IF NOT EXISTS idx_fo_profile_id ON funding_opportunities(profile_id);
CREATE INDEX IF NOT EXISTS idx_fo_funding_category ON funding_opportunities(funding_category);
CREATE INDEX IF NOT EXISTS idx_fo_funding_source_type ON funding_opportunities(funding_source_type);
CREATE INDEX IF NOT EXISTS idx_fo_usable_for_housing ON funding_opportunities(usable_for_housing);
CREATE INDEX IF NOT EXISTS idx_fo_verification_status ON funding_opportunities(verification_status);
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
    'curated_benefits',
    'health_resources',
    'comprehensive',
    'national',
    'item_search',
    'item_gift_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
    'national_zip_scan',
    'portal_check',
    'government_funding',
    'student_grants',
    'student_bridge_funding',
    'ecf_benefits',
    'ecf_hcbs',
    'special_needs',
    'local_funding',
    'item_matching',
    'anya_match_scout',
    'foundation_990',
    'clinical_trials',
    'live_search'
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
  profile_context_snapshot TEXT, -- JSON snapshot of complete profile context at dispatch time
  -- Client-/server-provided idempotency key to prevent duplicate dispatch.
  idempotency_key TEXT,
  result_count INTEGER DEFAULT 0,
  result_meta TEXT,
  error TEXT,
  requested_by TEXT,
  -- Dispatcher backpressure / retry tracking (separate from manual retry_count).
  dispatch_attempts INTEGER DEFAULT 0,
  next_dispatch_at DATETIME,
  retry_count INTEGER DEFAULT 0,
  last_retry_at DATETIME,
  -- Heartbeat timestamp updated periodically by long-running jobs to prove liveness.
  -- cleanupStaleCrawlers skips jobs with a recent heartbeat even if started_at is old.
  last_heartbeat_at DATETIME,
  -- Worker identity: which process/instance atomically claimed the running job.
  -- Populated by claimJob() when the queued -> running transition is applied.
  worker_id TEXT,
  -- Persistent attempt counter: incremented every time a worker claims this
  -- job. Distinct from dispatch_attempts (which resets on re-queue) and
  -- retry_count (which only ticks on stale orphan cleanup).
  attempt_count INTEGER DEFAULT 0,
  -- Timestamp of the atomic queued -> running transition.
  claimed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status ON crawler_jobs(status);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_profile ON crawler_jobs(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_type ON crawler_jobs(type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crawler_jobs_idempotency ON crawler_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_worker_id ON crawler_jobs(worker_id);
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status_heartbeat ON crawler_jobs(status, last_heartbeat_at);

-- Dead Letter Queue for persistent failure tracking and recovery
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- Job context
  job_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  profile_id TEXT,
  
  -- Failure details
  error_message TEXT NOT NULL,
  error_stack TEXT,
  error_code TEXT,
  
  -- Retry information
  retry_count INTEGER DEFAULT 0,
  last_retry_at DATETIME,
  next_retry_at DATETIME,
  
  -- Job state snapshot
  job_parameters TEXT, -- JSON snapshot of job parameters
  profile_context_snapshot TEXT, -- JSON snapshot of profile context
  
  -- Metadata
  severity TEXT CHECK(severity IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium',
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at DATETIME,
  resolved_by TEXT,
  resolution_notes TEXT,
  
  FOREIGN KEY (job_id) REFERENCES crawler_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_job_type ON dead_letter_queue(job_type, resolved);
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_profile_id ON dead_letter_queue(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_unresolved ON dead_letter_queue(created_at) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_retry ON dead_letter_queue(next_retry_at) WHERE next_retry_at IS NOT NULL AND resolved = FALSE;

-- Geo Crawl progress tracking (legacy table name: national_zip_progress)
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

-- Geo Crawl state runner history (Phase 6)
-- Tracks last run per state so Admin UI can show per-state counts and last run timestamp.
CREATE TABLE IF NOT EXISTS geo_state_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  state TEXT NOT NULL,
  job_id TEXT REFERENCES crawler_jobs(id) ON DELETE SET NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
  processed_zips INTEGER DEFAULT 0,
  sources_inserted INTEGER DEFAULT 0,
  failed_zips INTEGER DEFAULT 0,
  skipped_zips INTEGER DEFAULT 0,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_geo_state_runs_state ON geo_state_runs(state);
CREATE INDEX IF NOT EXISTS idx_geo_state_runs_created_at ON geo_state_runs(created_at);

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

-- Anya runs + logs (operational audit trail)
CREATE TABLE IF NOT EXISTS anya_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
  mode TEXT NOT NULL DEFAULT 'copilot' CHECK(mode IN ('copilot', 'admin_ops', 'code_advisor')),
  kind TEXT NOT NULL CHECK(kind IN ('assistant_message', 'tool_invoke')),
  session_id TEXT REFERENCES anya_sessions(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  tool_name TEXT,
  request_json TEXT DEFAULT '{}',
  response_json TEXT,
  -- Live-run observability + control: the orchestrator writes each tool step
  -- into progress_json (watch-her-work feed) and checks cancel_requested
  -- between steps (Stop/Escape). See services/anyaRuns.js.
  progress_json TEXT DEFAULT '[]',
  cancel_requested INTEGER DEFAULT 0,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_anya_runs_session ON anya_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_anya_runs_user ON anya_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_anya_runs_status ON anya_runs(status);

CREATE TABLE IF NOT EXISTS anya_run_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT NOT NULL REFERENCES anya_runs(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_anya_run_logs_run ON anya_run_logs(run_id);

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

-- ----------------------------
-- Profile Action Plan (Printable To-Do) — persisted plan + per-item completion
-- so the checklist survives reload/Regenerate and "done" is profile-scoped.
-- plan + completions are JSON stored as TEXT in both dialects (parsed in app).
-- completions maps a stable item key (category::title) -> { done, doc_id, at }.
-- ----------------------------
CREATE TABLE IF NOT EXISTS profile_todo_plans (
  profile_id TEXT PRIMARY KEY,
  plan TEXT,
  completions TEXT NOT NULL DEFAULT '{}',
  applicant_name TEXT,
  generated_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------
-- Services Catalog + Stripe (Payment Sheet-driven)
-- ----------------------------
CREATE TABLE IF NOT EXISTS service_catalog_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  pricing_model TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_prices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  service_id TEXT NOT NULL REFERENCES service_catalog_items(id) ON DELETE CASCADE,
  client_category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  milestone_phase TEXT,
  stripe_price_id TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(service_id, client_category, currency, milestone_phase)
);

CREATE TABLE IF NOT EXISTS service_terms (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  version TEXT NOT NULL UNIQUE,
  policy_snippet TEXT NOT NULL,
  full_text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_purchases (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT,
  profile_id TEXT,
  organization_id TEXT,
  service_id TEXT NOT NULL REFERENCES service_catalog_items(id),
  client_category TEXT NOT NULL,
  pricing_model TEXT NOT NULL,
  status TEXT NOT NULL,
  agreed_terms_version TEXT,
  agreed_at DATETIME,
  stripe_customer_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS milestone_payments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  purchase_id TEXT NOT NULL REFERENCES service_purchases(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(purchase_id, phase)
);

CREATE TABLE IF NOT EXISTS hourly_time_entries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  purchase_id TEXT NOT NULL REFERENCES service_purchases(id) ON DELETE CASCADE,
  minutes INTEGER NOT NULL,
  rounded_minutes INTEGER NOT NULL,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hourly_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  purchase_id TEXT NOT NULL REFERENCES service_purchases(id) ON DELETE CASCADE,
  total_rounded_minutes INTEGER NOT NULL,
  units INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT,
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stripe_customers (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_service_prices_service ON service_prices(service_id);
CREATE INDEX IF NOT EXISTS idx_service_purchases_user ON service_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_milestone_purchase ON milestone_payments(purchase_id);
CREATE INDEX IF NOT EXISTS idx_hourly_time_purchase ON hourly_time_entries(purchase_id);
CREATE INDEX IF NOT EXISTS idx_hourly_invoice_purchase ON hourly_invoices(purchase_id);

-- Curated crawler system tables (v2)
CREATE TABLE IF NOT EXISTS crawl_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  program_name TEXT NOT NULL,
  program_url TEXT,
  program_description TEXT,
  match_score INTEGER NOT NULL,
  match_reasons TEXT,
  matched_categories TEXT,
  program_type TEXT,
  funding_type TEXT,
  max_amount REAL,
  source_type TEXT,
  crawled_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(profile_id, program_id)
);

CREATE TABLE IF NOT EXISTS crawl_metadata (
  profile_id TEXT PRIMARY KEY,
  needs TEXT,
  demographics TEXT,
  health_signals TEXT,
  family_signals TEXT,
  military_signals TEXT,
  state TEXT,
  analysis_json TEXT,
  county TEXT,
  state_portal_url TEXT,
  state_portal_name TEXT,
  county_contacts TEXT,
  total_matches INTEGER,
  crawled_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crawl_results_profile ON crawl_results(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawl_results_score ON crawl_results(match_score DESC);

-- Vehicle Opportunities pipeline (see migration 037_vehicle_opportunities.sql for Postgres equivalent)
CREATE TABLE IF NOT EXISTS vehicle_opportunities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  vehicle_type TEXT NOT NULL,
  title TEXT NOT NULL,
  price REAL,
  mileage INTEGER,
  year INTEGER,
  transmission TEXT,
  color TEXT,
  location TEXT,
  link TEXT NOT NULL,
  vin TEXT,
  clean_title INTEGER DEFAULT 1,
  source TEXT,
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_opportunities_link ON vehicle_opportunities(link);
CREATE INDEX IF NOT EXISTS idx_vehicle_opportunities_created_at ON vehicle_opportunities(created_at);

-- Exclusion Rules (procurement noise suppression)
CREATE TABLE IF NOT EXISTS exclusion_rules (
  rule_id TEXT PRIMARY KEY,
  pattern TEXT,
  action TEXT,
  confidence_score REAL
);

-- Exclusion Audit (trail of suppression decisions)
CREATE TABLE IF NOT EXISTS exclusion_audit (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  rule_id TEXT,
  opportunity_id TEXT,
  decision TEXT,
  false_positive BOOLEAN,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Low-coverage telemetry (Smart Matcher spec §7).
-- One row per Discover/SmartMatcher search where qualified_count < 3.
-- Fed by routes/matching.js → /profile/:profileId/opportunities. Lets admins
-- iteratively fill funder source gaps and surface frequent low-coverage
-- queries on the Anya Admin dashboard.
CREATE TABLE IF NOT EXISTS low_coverage_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT,
  primary_category TEXT,
  search_terms TEXT,
  qualified_count INTEGER,
  returned_count INTEGER,
  candidate_count INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_low_coverage_created
  ON low_coverage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_low_coverage_profile
  ON low_coverage_events(profile_id);
CREATE INDEX IF NOT EXISTS idx_low_coverage_category
  ON low_coverage_events(primary_category);

-- Match feedback (Smart Matcher spec §7 — "Not relevant / Wrong category").
-- Lightweight per-result feedback that future scorer iterations can read to
-- down-weight chronically irrelevant opportunities for a given query type.
CREATE TABLE IF NOT EXISTS match_feedback (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT,
  opportunity_id TEXT,
  primary_category TEXT,
  feedback TEXT,        -- 'not_relevant' | 'wrong_category' | 'low_quality' | 'helpful'
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_match_feedback_profile
  ON match_feedback(profile_id);
CREATE INDEX IF NOT EXISTS idx_match_feedback_opp
  ON match_feedback(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_match_feedback_created
  ON match_feedback(created_at DESC);

-- ─── Pricing engine quotes (mirrors migration 079) ──────────────────────────
-- Tables that back the GrantFlow pricing engine. Catalog itself lives in
-- code (versioned by PRICING_CATALOG_VERSION). All idempotent.

CREATE TABLE IF NOT EXISTS pricing_quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  profile_id TEXT NOT NULL,
  intake_session_id TEXT,
  pricing_catalog_version TEXT NOT NULL,
  client_category TEXT NOT NULL,
  category_confidence TEXT,
  recommended_package_name TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_terms_json TEXT,
  admin_review_required INTEGER NOT NULL DEFAULT 1,
  quote_status TEXT NOT NULL DEFAULT 'internal_recommendation',
  reasons_json TEXT,
  missing_inputs_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pricing_quotes_profile ON pricing_quotes(profile_id);
CREATE INDEX IF NOT EXISTS idx_pricing_quotes_status_created ON pricing_quotes(quote_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_quotes_admin_review ON pricing_quotes(admin_review_required, created_at DESC);

CREATE TABLE IF NOT EXISTS pricing_quote_line_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  service_key TEXT NOT NULL,
  service_name TEXT NOT NULL,
  client_category TEXT NOT NULL,
  base_price REAL NOT NULL DEFAULT 0,
  quantity REAL NOT NULL DEFAULT 1,
  subtotal REAL NOT NULL DEFAULT 0,
  reason TEXT,
  confidence REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (quote_id) REFERENCES pricing_quotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pricing_quote_line_items_quote ON pricing_quote_line_items(quote_id);

CREATE TABLE IF NOT EXISTS pricing_quote_discounts (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  discount_key TEXT NOT NULL,
  label TEXT,
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  reason TEXT,
  requires_admin_approval INTEGER NOT NULL DEFAULT 1,
  approved INTEGER NOT NULL DEFAULT 0,
  approved_by_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (quote_id) REFERENCES pricing_quotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pricing_quote_discounts_quote ON pricing_quote_discounts(quote_id);

CREATE TABLE IF NOT EXISTS pricing_discount_rules (
  id TEXT PRIMARY KEY,
  discount_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value REAL NOT NULL DEFAULT 0,
  max_amount REAL,
  applies_to_services_json TEXT,
  requires_admin_approval INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pricing_discount_rules_enabled ON pricing_discount_rules(enabled);

-- ─── Sam onboarding audit (mirrors migration 078) ───────────────────────────
-- Telemetry that Sam's onboarding auditor reads. Created here so a freshly
-- bootstrapped dev DB has the tables even before running the full migration
-- chain. All idempotent.

CREATE TABLE IF NOT EXISTS anya_onboarding_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  profile_id TEXT,
  branch TEXT,
  event_type TEXT NOT NULL,
  question_id TEXT,
  field_key TEXT,
  status TEXT,
  confidence REAL,
  details_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_session ON anya_onboarding_events(session_id);
CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_user ON anya_onboarding_events(user_id);
CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_branch_created ON anya_onboarding_events(branch, created_at);
CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_event_type ON anya_onboarding_events(event_type);

CREATE TABLE IF NOT EXISTS anya_onboarding_audit_runs (
  id TEXT PRIMARY KEY,
  started_at DATETIME NOT NULL,
  completed_at DATETIME,
  status TEXT NOT NULL DEFAULT 'ok',
  flow_version TEXT,
  branches_checked_json TEXT,
  coverage_json TEXT,
  findings_json TEXT,
  recommendations_json TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_anya_audit_runs_completed ON anya_onboarding_audit_runs(completed_at);

CREATE TABLE IF NOT EXISTS anya_onboarding_audit_findings (
  id TEXT PRIMARY KEY,
  audit_run_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  branch TEXT,
  question_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  evidence_json TEXT,
  recommended_fix TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_run_id) REFERENCES anya_onboarding_audit_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_anya_audit_findings_run ON anya_onboarding_audit_findings(audit_run_id);
CREATE INDEX IF NOT EXISTS idx_anya_audit_findings_status ON anya_onboarding_audit_findings(status);
CREATE INDEX IF NOT EXISTS idx_anya_audit_findings_severity ON anya_onboarding_audit_findings(severity);

-- ============================================================================
-- Agent Mission Control — unified telemetry tables.
-- Canonical definitions live in backend/db/migrations/084_agent_telemetry.sql.
-- Repeated here so fresh databases bootstrapped from schema.sql get them
-- without needing to walk the migration sequence.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_activity_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT,
  severity TEXT,
  title TEXT,
  description TEXT,
  metric_key TEXT,
  metric_value REAL,
  entity_type TEXT,
  entity_id TEXT,
  user_id TEXT,
  profile_id TEXT,
  organization_id TEXT,
  state TEXT,
  county TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  details_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_events_agent_created
  ON agent_activity_events(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_status_created
  ON agent_activity_events(status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_daily_rollups (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_name TEXT NOT NULL,
  rollup_date TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value REAL NOT NULL DEFAULT 0,
  details_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_name, rollup_date, metric_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_rollups_agent_date
  ON agent_daily_rollups(agent_name, rollup_date DESC);
-- ============================================================================
-- John — Outreach Drafting Agent (Outlook drafts; never sends).
-- See backend/db/migrations/083_john_tables.sql for canonical definitions.
-- Yana — Lead Discovery & Outreach Agent (legacy table prefix `larry_*`).
-- See backend/db/migrations/082_larry_tables.sql for the canonical definitions.
-- Repeated here so fresh databases bootstrapped from schema.sql get the tables
-- without needing to run the migration sequence.
-- ============================================================================

CREATE TABLE IF NOT EXISTS john_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  yana_leads_considered INTEGER DEFAULT 0,
  drafts_created INTEGER DEFAULT 0,
  drafts_blocked INTEGER DEFAULT 0,
  drafts_failed INTEGER DEFAULT 0,
  alias_report_json TEXT,
  summary_json TEXT,
  error TEXT,
  created_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_john_runs_started_at ON john_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_john_runs_status ON john_runs(status);

CREATE TABLE IF NOT EXISTS larry_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  prospects_considered INTEGER DEFAULT 0,
  prospects_verified INTEGER DEFAULT 0,
  leads_qualified INTEGER DEFAULT 0,
  packets_built INTEGER DEFAULT 0,
  outreach_drafted INTEGER DEFAULT 0,
  outreach_sent INTEGER DEFAULT 0,
  outreach_failed INTEGER DEFAULT 0,
  outreach_replies INTEGER DEFAULT 0,
  do_not_contact_blocked INTEGER DEFAULT 0,
  rejection_reasons_json TEXT,
  summary_json TEXT,
  error TEXT,
  created_by_user_id TEXT
);

CREATE TABLE IF NOT EXISTS john_email_drafts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  yana_lead_id TEXT,
  run_id TEXT,
  organization_name TEXT,
  recipient_email TEXT,
  recipient_name TEXT,
  recipient_role TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  from_mailbox TEXT,
  from_alias TEXT,
  reply_to TEXT,
  display_name TEXT,
  provider TEXT,
  provider_draft_id TEXT,
  provider_message_id TEXT,
  draft_status TEXT NOT NULL DEFAULT 'created',
  safety_status TEXT,
  safety_report_json TEXT,
  alias_report_json TEXT,
  personalization_json TEXT,
  source_evidence_json TEXT,
  needs_sender_alias_review INTEGER DEFAULT 0,
  fallback_used INTEGER DEFAULT 0,
  archived_at DATETIME,
  archived_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_john_drafts_status ON john_email_drafts(draft_status);
CREATE INDEX IF NOT EXISTS idx_john_drafts_yana_lead ON john_email_drafts(yana_lead_id);
CREATE INDEX IF NOT EXISTS idx_john_drafts_created_at ON john_email_drafts(created_at DESC);

CREATE TABLE IF NOT EXISTS john_suppression_list (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  suppression_type TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT,
  source TEXT,
  added_by_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (suppression_type, value)
);

CREATE INDEX IF NOT EXISTS idx_john_suppression_value ON john_suppression_list(value);

CREATE TABLE IF NOT EXISTS john_email_audit (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_name TEXT NOT NULL DEFAULT 'John',
  yana_lead_id TEXT,
  draft_id TEXT,
  recipient_email TEXT,
  organization_name TEXT,
  subject TEXT,
  from_mailbox TEXT,
  from_alias TEXT,
  reply_to TEXT,
  status TEXT NOT NULL,
  provider_draft_id TEXT,
  safety_report_json TEXT,
  alias_report_json TEXT,
  error TEXT,
  created_by_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_john_audit_status ON john_email_audit(status);
CREATE INDEX IF NOT EXISTS idx_john_audit_lead ON john_email_audit(yana_lead_id);
CREATE INDEX IF NOT EXISTS idx_john_audit_draft ON john_email_audit(draft_id);

CREATE TABLE IF NOT EXISTS john_alias_checks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  primary_mailbox TEXT,
  from_alias TEXT,
  alias_verified INTEGER DEFAULT 0,
  alias_send_supported INTEGER DEFAULT 0,
  test_draft_provider_id TEXT,
  details_json TEXT,
  error TEXT,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_john_alias_checks_at ON john_alias_checks(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_larry_runs_started_at ON larry_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_larry_runs_status ON larry_runs(status);

CREATE TABLE IF NOT EXISTS larry_prospect_candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT,
  source_name TEXT,
  source_url TEXT,
  source_type TEXT,
  organization_name TEXT NOT NULL,
  organization_legal_name TEXT,
  organization_type TEXT,
  organization_subtype TEXT,
  ein TEXT,
  website_url TEXT,
  primary_contact_name TEXT,
  primary_contact_role TEXT,
  primary_contact_email TEXT,
  primary_contact_phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  county TEXT,
  geography_scope TEXT,
  applicant_type TEXT,
  need_categories_json TEXT,
  programs_json TEXT,
  signals_json TEXT,
  raw_payload_json TEXT,
  discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_checked_at DATETIME,
  status TEXT DEFAULT 'discovered',
  rejection_reason TEXT,
  evidence_json TEXT,
  contact_verification_status TEXT DEFAULT 'unverified',
  contact_verification_reasons_json TEXT,
  fit_score INTEGER,
  urgency_score INTEGER,
  composite_score INTEGER,
  qualified BOOLEAN DEFAULT 0,
  do_not_contact BOOLEAN DEFAULT 0,
  do_not_contact_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_larry_prospects_status ON larry_prospect_candidates(status);
CREATE INDEX IF NOT EXISTS idx_larry_prospects_qualified ON larry_prospect_candidates(qualified, composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_larry_prospects_state ON larry_prospect_candidates(state);

CREATE TABLE IF NOT EXISTS larry_leads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  prospect_candidate_id TEXT NOT NULL,
  run_id TEXT,
  packet_version INTEGER NOT NULL DEFAULT 1,
  packet_json TEXT,
  packet_summary TEXT,
  fit_score INTEGER,
  urgency_score INTEGER,
  composite_score INTEGER,
  fit_reasons_json TEXT,
  urgency_reasons_json TEXT,
  recommended_pitch TEXT,
  recommended_outreach_method TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  qualified_at DATETIME,
  qualified_by_user_id TEXT,
  approved_for_outreach BOOLEAN DEFAULT 0,
  approved_for_outreach_at DATETIME,
  approved_for_outreach_by_user_id TEXT,
  archived_at DATETIME,
  archived_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (prospect_candidate_id, packet_version)
);

CREATE INDEX IF NOT EXISTS idx_larry_leads_status ON larry_leads(status);
CREATE INDEX IF NOT EXISTS idx_larry_leads_score ON larry_leads(composite_score DESC);

CREATE TABLE IF NOT EXISTS larry_outreach_attempts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lead_id TEXT NOT NULL,
  prospect_candidate_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  template_id TEXT,
  draft_subject TEXT,
  draft_body TEXT,
  draft_text TEXT,
  draft_metadata_json TEXT,
  drafted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  drafted_by TEXT NOT NULL DEFAULT 'larry',
  approved_at DATETIME,
  approved_by_user_id TEXT,
  send_status TEXT NOT NULL DEFAULT 'drafted',
  sent_at DATETIME,
  sent_to_email TEXT,
  sent_to_phone TEXT,
  send_provider TEXT,
  send_provider_message_id TEXT,
  send_error TEXT,
  reply_received_at DATETIME,
  reply_classification TEXT,
  reply_summary TEXT,
  bounce_status TEXT,
  unsubscribed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_larry_outreach_lead ON larry_outreach_attempts(lead_id);
CREATE INDEX IF NOT EXISTS idx_larry_outreach_status ON larry_outreach_attempts(send_status);

CREATE TABLE IF NOT EXISTS larry_relationships (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  prospect_candidate_id TEXT NOT NULL,
  relationship_state TEXT NOT NULL DEFAULT 'none',
  last_contacted_at DATETIME,
  last_replied_at DATETIME,
  contact_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until DATETIME,
  do_not_contact BOOLEAN NOT NULL DEFAULT 0,
  do_not_contact_reason TEXT,
  do_not_contact_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (prospect_candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_larry_relationships_state ON larry_relationships(relationship_state);

CREATE TABLE IF NOT EXISTS larry_suppression_list (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  reason TEXT,
  added_by_user_id TEXT,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (identifier_type, identifier_value)
);

CREATE INDEX IF NOT EXISTS idx_larry_suppression_value ON larry_suppression_list(identifier_value);

CREATE TABLE IF NOT EXISTS larry_domain_rate_limits (
  domain TEXT PRIMARY KEY,
  window_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_request_at DATETIME,
  blocked_until DATETIME,
  last_error TEXT
);

-- Hamilton (formerly Yana autopilot) student portal layer + application tasks (migration 085).
-- See backend/db/migrations/085_yana_student_portals_and_application_tasks.sql
-- for the canonical definition; the migration is the source of truth and is
-- replayed on every boot.

CREATE TABLE IF NOT EXISTS student_portals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id TEXT,
  school_id TEXT,
  school_normalized TEXT,
  school_display_name TEXT,
  portal_type TEXT NOT NULL CHECK(portal_type IN (
    'financial_aid','scholarship','admissions','student_account','bursar',
    'department','graduate_school','program_specific','external_application','manual_or_offline'
  )),
  portal_name TEXT,
  portal_url TEXT,
  login_url TEXT,
  application_url TEXT,
  sso_required INTEGER NOT NULL DEFAULT 0,
  credentials_required INTEGER NOT NULL DEFAULT 0,
  credentials_status TEXT NOT NULL DEFAULT 'unknown' CHECK(credentials_status IN (
    'unknown','needed','stored_reference','user_session_required','unavailable'
  )),
  last_checked_at DATETIME,
  last_check_status TEXT,
  source TEXT NOT NULL DEFAULT 'inferred' CHECK(source IN (
    'profile','knownSchools','crawler','user_entered','inferred'
  )),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
  reason TEXT,
  metadata_json TEXT DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_student_portals_profile_id ON student_portals(profile_id);
CREATE INDEX IF NOT EXISTS idx_student_portals_user_id    ON student_portals(user_id);
CREATE INDEX IF NOT EXISTS idx_student_portals_school     ON student_portals(school_normalized);
CREATE INDEX IF NOT EXISTS idx_student_portals_type       ON student_portals(portal_type);
CREATE INDEX IF NOT EXISTS idx_student_portals_active     ON student_portals(active);
CREATE UNIQUE INDEX IF NOT EXISTS ux_student_portals_profile_school_type
  ON student_portals(profile_id, COALESCE(school_normalized,''), portal_type);

CREATE TABLE IF NOT EXISTS application_portal_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id TEXT,
  opportunity_id TEXT,
  grant_id TEXT,
  portal_id TEXT REFERENCES student_portals(id) ON DELETE SET NULL,
  school_id TEXT,
  portal_type TEXT NOT NULL,
  action_type TEXT,
  application_url TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  missing_requirements_json TEXT NOT NULL DEFAULT '[]',
  can_yana_attempt INTEGER NOT NULL DEFAULT 0,
  requires_user_login INTEGER NOT NULL DEFAULT 0,
  requires_admin_review INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_profile      ON application_portal_links(profile_id);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_opp          ON application_portal_links(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_grant        ON application_portal_links(grant_id);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_portal       ON application_portal_links(portal_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_portal_links_profile_opp
  ON application_portal_links(profile_id, COALESCE(opportunity_id,''), COALESCE(grant_id,''));

CREATE TABLE IF NOT EXISTS application_tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT,
  grant_id TEXT,
  portal_id TEXT REFERENCES student_portals(id) ON DELETE SET NULL,
  application_id TEXT,
  assigned_agent TEXT NOT NULL DEFAULT 'yana',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','ready','waiting_for_user','waiting_for_admin','blocked_login_required',
    'blocked_missing_info','blocked_2fa','blocked_captcha','blocked_terms_or_policy',
    'in_progress','draft_completed','submitted','failed','cancelled'
  )),
  current_step TEXT,
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  missing_documents_json TEXT NOT NULL DEFAULT '[]',
  required_user_actions_json TEXT NOT NULL DEFAULT '[]',
  last_agent_message TEXT,
  auto_submit_enabled INTEGER NOT NULL DEFAULT 0,
  submitted_at DATETIME,
  cancelled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- ?? Automation-task extension (migration 087). Adds the columns the
  -- "Automate with Yana" select-many flow needs.
  automation_type TEXT NOT NULL DEFAULT 'unknown',
  selected_from_stage TEXT,
  current_pipeline_stage TEXT,
  agent_persona_version TEXT NOT NULL DEFAULT 'yana-mba-2026',
  portal_url TEXT,
  application_url TEXT,
  university_application_id TEXT,
  output_document_id TEXT,
  output_pdf_document_id TEXT,
  output_docx_document_id TEXT,
  mailing_instructions_json TEXT NOT NULL DEFAULT '{}',
  audit_summary_json TEXT NOT NULL DEFAULT '{}',
  allow_auto_submit INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME,
  completed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_application_tasks_profile          ON application_tasks(profile_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_user             ON application_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_opp              ON application_tasks(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_grant            ON application_tasks(grant_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_status           ON application_tasks(status);
CREATE INDEX IF NOT EXISTS idx_application_tasks_automation_type  ON application_tasks(automation_type);
CREATE INDEX IF NOT EXISTS idx_application_tasks_selected_stage   ON application_tasks(selected_from_stage);
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_tasks_profile_subject
  ON application_tasks(profile_id, COALESCE(opportunity_id,''), COALESCE(grant_id,''));

CREATE TABLE IF NOT EXISTS application_task_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL REFERENCES application_tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT,
  step TEXT,
  message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  actor_user_id TEXT,
  actor_role TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_application_task_events_task ON application_task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_application_task_events_type ON application_task_events(event_type);
CREATE INDEX IF NOT EXISTS idx_application_task_events_created ON application_task_events(created_at);

CREATE TABLE IF NOT EXISTS application_missing_info (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL REFERENCES application_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('field','document','login','consent','signature','attestation','admin_review','other')),
  key TEXT NOT NULL,
  label TEXT,
  description TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at DATETIME,
  resolved_by TEXT,
  resolved_value_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_application_missing_info_task ON application_missing_info(task_id);
CREATE INDEX IF NOT EXISTS idx_application_missing_info_kind ON application_missing_info(kind);
CREATE INDEX IF NOT EXISTS idx_application_missing_info_resolved ON application_missing_info(resolved);
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_missing_info_task_kind_key
  ON application_missing_info(task_id, kind, key);

CREATE TABLE IF NOT EXISTS hamilton_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT,
  profile_id TEXT,
  user_id TEXT,
  mode TEXT NOT NULL DEFAULT 'observe',
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  application_tasks_processed INTEGER DEFAULT 0,
  fields_filled INTEGER DEFAULT 0,
  missing_info_detected INTEGER DEFAULT 0,
  drafts_completed INTEGER DEFAULT 0,
  submissions_completed INTEGER DEFAULT 0,
  blocked_safety INTEGER DEFAULT 0,
  notifications_emitted INTEGER DEFAULT 0,
  urls_fetched INTEGER DEFAULT 0,
  leads_found INTEGER DEFAULT 0,
  summary_json TEXT DEFAULT '{}',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_hamilton_runs_task     ON hamilton_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_runs_profile  ON hamilton_runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_runs_started  ON hamilton_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_hamilton_runs_status   ON hamilton_runs(status);


-- ── Hamilton Autopilot authorization model (migration 088) ─────────────
CREATE TABLE IF NOT EXISTS hamilton_authorizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('profile','task','funding_source')),
  authorization_type TEXT NOT NULL,
  funding_source_id TEXT,
  task_id TEXT,
  authorization_text TEXT NOT NULL,
  authorization_version TEXT NOT NULL DEFAULT 'yana-autopilot-v1',
  options_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  revoked_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_user    ON hamilton_authorizations(user_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_profile ON hamilton_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_scope   ON hamilton_authorizations(scope);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_type    ON hamilton_authorizations(authorization_type);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_funding ON hamilton_authorizations(funding_source_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_task    ON hamilton_authorizations(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_active  ON hamilton_authorizations(profile_id, authorization_type, revoked_at);

CREATE TABLE IF NOT EXISTS hamilton_portal_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  portal_url TEXT,
  integration_modes TEXT NOT NULL DEFAULT 'pilot_manual_import',
  live_supported INTEGER NOT NULL DEFAULT 0,
  automation_supported INTEGER NOT NULL DEFAULT 0,
  authentication_strategy TEXT,
  session_reuse_supported INTEGER NOT NULL DEFAULT 0,
  credential_reference_supported INTEGER NOT NULL DEFAULT 0,
  captcha_likely INTEGER NOT NULL DEFAULT 0,
  two_factor_likely INTEGER NOT NULL DEFAULT 0,
  tos_notes TEXT,
  adapter_name TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hamilton_autopilot_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  authorization_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','preflight','running','blocked','completed','submitted','failed','cancelled'
  )),
  blocker_kind TEXT,
  blocker_detail TEXT,
  preflight_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  confirmation_reference TEXT,
  confirmation_screenshot_path TEXT,
  started_at DATETIME,
  finished_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_task     ON hamilton_autopilot_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_profile  ON hamilton_autopilot_runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_status   ON hamilton_autopilot_runs(status);


-- == migration 089: yana hard-stop resolution =========================
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

CREATE TABLE IF NOT EXISTS hamilton_blockers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  funding_source_id TEXT,
  blocker_type TEXT NOT NULL,           -- one of the 15 categories
  blocker_source TEXT,                  -- preflight | engine | classifier | manual
  blocker_title TEXT,
  blocker_message TEXT,
  blocker_text TEXT,                    -- captured page text / field name
  severity TEXT NOT NULL DEFAULT 'warning',
  required_action TEXT,
  resolver_route TEXT,
  admin_required INTEGER NOT NULL DEFAULT 0,
  user_required INTEGER NOT NULL DEFAULT 1,
  deadline_at DATETIME,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolution_strategy TEXT,             -- which resolver was attempted
  resolved_at DATETIME,
  resolved_by_user_id TEXT,
  unresolved_reason TEXT,
  user_notification_id TEXT,
  admin_notification_ids TEXT,
  requires_user_action INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_task     ON hamilton_blockers(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_profile  ON hamilton_blockers(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_type     ON hamilton_blockers(blocker_type);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_open     ON hamilton_blockers(task_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_admin    ON hamilton_blockers(admin_required, resolved_at);

CREATE TABLE IF NOT EXISTS hamilton_blocker_resolutions (
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
CREATE INDEX IF NOT EXISTS idx_hamilton_blocker_res_blocker ON hamilton_blocker_resolutions(blocker_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_blocker_res_task    ON hamilton_blocker_resolutions(task_id);

-- Saved authenticated browser sessions (Playwright storageState file
-- pointers, never the storage state contents themselves).
CREATE TABLE IF NOT EXISTS hamilton_saved_sessions (
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
CREATE INDEX IF NOT EXISTS idx_hamilton_sessions_profile ON hamilton_saved_sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_sessions_host    ON hamilton_saved_sessions(portal_host);
CREATE INDEX IF NOT EXISTS idx_hamilton_sessions_status  ON hamilton_saved_sessions(status);

-- Pre-authorized payment categories. Payment_method_reference is a
-- token from a PCI-compliant processor (Stripe payment_method_id,
-- etc.). Raw card data is NEVER stored here.
CREATE TABLE IF NOT EXISTS hamilton_payment_authorizations (
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
CREATE INDEX IF NOT EXISTS idx_hamilton_pay_profile ON hamilton_payment_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_pay_active  ON hamilton_payment_authorizations(profile_id, category, revoked_at);

-- Standing attestation authorizations. Each row says: "the user has
-- authorized Yana to tick attestation checkboxes that match this
-- category" (e.g. "information is accurate to the best of my
-- knowledge"). Yana NEVER ticks penalty-of-perjury / wet-signature
-- attestations from this table.
CREATE TABLE IF NOT EXISTS hamilton_attestation_authorizations (
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
CREATE INDEX IF NOT EXISTS idx_hamilton_attest_profile ON hamilton_attestation_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_attest_active  ON hamilton_attestation_authorizations(profile_id, category, revoked_at);

-- Portal policy registry. One row per unique portal host telling Yana
-- whether automation is permitted, and what the lawful fallback path
-- is when it is not.
CREATE TABLE IF NOT EXISTS hamilton_portal_policies (
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
CREATE INDEX IF NOT EXISTS idx_hamilton_policy_host ON hamilton_portal_policies(portal_host);

-- Resolved-field cache. When Yana asks the user for a missing or
-- ambiguous field once, we save the answer for future portals so the
-- same question is never asked twice.
CREATE TABLE IF NOT EXISTS hamilton_resolved_fields (
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
CREATE INDEX IF NOT EXISTS idx_hamilton_resolved_profile ON hamilton_resolved_fields(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_resolved_key     ON hamilton_resolved_fields(profile_id, field_key);

-- ---------------------------------------------------------------------------
-- Agent Control Center (migration 091).
--
-- Admin-only orchestration runs. The single canonical admin/operator
-- (buckeye7066@gmail.com) starts/stops/pauses/resumes the whole agent
-- process from Admin Mission Control. Stop requests are persisted so they
-- survive process restarts and the orchestrator polls them between atomic
-- operations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_control_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_name TEXT,
  run_type TEXT NOT NULL CHECK(run_type IN (
    'full_cycle','selected_agents','sam_only','robert_only',
    'yana_only','john_only','hamilton_only','scheduled_cycle'
  )),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','running','pausing','paused','stopping','stopped',
    'completed','completed_noop','failed','cancelled','partial_stop','stop_failed'
  )),
  started_by_user_id TEXT,
  started_by_email TEXT,
  admin_email TEXT NOT NULL DEFAULT 'buckeye7066@gmail.com',
  requested_agents_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '{}',
  cancellation_requested_at DATETIME,
  pause_requested_at DATETIME,
  resume_requested_at DATETIME,
  started_at DATETIME,
  completed_at DATETIME,
  error_message TEXT,
  summary_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_control_runs_status      ON agent_control_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_control_runs_run_type    ON agent_control_runs(run_type);
CREATE INDEX IF NOT EXISTS idx_agent_control_runs_started_at  ON agent_control_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_runs_created_at  ON agent_control_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_runs_admin       ON agent_control_runs(admin_email);

CREATE TABLE IF NOT EXISTS agent_control_steps (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  control_run_id TEXT NOT NULL,
  agent_name TEXT NOT NULL CHECK(agent_name IN (
    'sam','robert','yana','john','hamilton'
  )),
  step_name TEXT NOT NULL,
  step_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','running','paused','stopping','stopped',
    'completed','failed','skipped','blocked'
  )),
  started_at DATETIME,
  completed_at DATETIME,
  heartbeat_at DATETIME,
  cancellation_checked_at DATETIME,
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_control_steps_run        ON agent_control_steps(control_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_control_steps_agent      ON agent_control_steps(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_control_steps_status     ON agent_control_steps(status);
CREATE INDEX IF NOT EXISTS idx_agent_control_steps_run_order  ON agent_control_steps(control_run_id, step_order);

CREATE TABLE IF NOT EXISTS agent_control_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  control_run_id TEXT,
  step_id TEXT,
  agent_name TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN (
    'critical','high','medium','low','info'
  )),
  message TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_control_events_run       ON agent_control_events(control_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_events_agent     ON agent_control_events(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_events_type      ON agent_control_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_control_events_severity  ON agent_control_events(severity, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_control_locks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lock_name TEXT NOT NULL UNIQUE,
  control_run_id TEXT NOT NULL,
  owner_token TEXT,
  acquired_by TEXT,
  acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_agent_control_locks_run        ON agent_control_locks(control_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_control_locks_expires    ON agent_control_locks(expires_at);

CREATE TABLE IF NOT EXISTS agent_control_stop_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  control_run_id TEXT NOT NULL,
  agent_name TEXT,
  requested_by_email TEXT,
  requested_by_user_id TEXT,
  request_type TEXT NOT NULL CHECK(request_type IN (
    'pause','resume','graceful_stop','emergency_stop','cancel'
  )),
  reason TEXT,
  fulfilled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_control_stop_run         ON agent_control_stop_requests(control_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_control_stop_unfulfilled ON agent_control_stop_requests(control_run_id, fulfilled_at);
CREATE INDEX IF NOT EXISTS idx_agent_control_stop_agent       ON agent_control_stop_requests(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_control_stop_type        ON agent_control_stop_requests(request_type);

-- Yana — Client Discovery / Lead Funnel (mission Goal 14). See
-- backend/db/migrations/093_yana_lead_discovery.sql.
CREATE TABLE IF NOT EXISTS yana_lead_candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT,
  profile_id TEXT,
  source TEXT DEFAULT 'organizations',
  external_id TEXT,
  entity_type TEXT,
  organization_name TEXT,
  organization_type TEXT,
  website_url TEXT,
  location TEXT,
  contact_email TEXT,
  funding_need_summary TEXT,
  grantflow_fit_summary TEXT,
  public_evidence_json TEXT NOT NULL DEFAULT '[]',
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  do_not_contact_flags_json TEXT NOT NULL DEFAULT '[]',
  fit_score INTEGER NOT NULL DEFAULT 0,
  urgency_score INTEGER NOT NULL DEFAULT 0,
  contact_confidence INTEGER NOT NULL DEFAULT 0,
  lead_score INTEGER NOT NULL DEFAULT 0,
  qualification_status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (qualification_status IN ('candidate', 'qualified', 'unqualified', 'needs_enrichment')),
  qualification_reasons_json TEXT NOT NULL DEFAULT '[]',
  pushed_to_john INTEGER NOT NULL DEFAULT 0,
  pushed_at DATETIME,
  run_id TEXT,
  enrich_attempts INTEGER NOT NULL DEFAULT 0,
  last_enrich_attempt_at DATETIME,
  discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id)
);
CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_status  ON yana_lead_candidates(qualification_status);
CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_pushed  ON yana_lead_candidates(pushed_to_john);
CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_profile ON yana_lead_candidates(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_yana_candidates_source_extid ON yana_lead_candidates(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_yana_candidates_push ON yana_lead_candidates(qualification_status, pushed_to_john, lead_score);

CREATE TABLE IF NOT EXISTS yana_lead_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL DEFAULT 'observe',
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  candidates_total INTEGER NOT NULL DEFAULT 0,
  candidates_qualified INTEGER NOT NULL DEFAULT 0,
  leads_pushed_to_john INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_by_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_yana_lead_runs_started ON yana_lead_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_yana_lead_runs_status  ON yana_lead_runs(status);

-- Owner Blocklist — canonical denylist (see migration 109_owner_blocklist.sql).
-- The users.status/blocked_* ban columns live in the migration only, on purpose,
-- so a fresh-DB bootstrap never collides with that ALTER.
CREATE TABLE IF NOT EXISTS owner_blocklist (
  id TEXT PRIMARY KEY,
  match_type TEXT NOT NULL,
  match_value TEXT NOT NULL,
  match_value_raw TEXT,
  reason TEXT,
  source TEXT,
  enforcement TEXT NOT NULL DEFAULT 'block',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  added_by_user_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_blocklist_type_value ON owner_blocklist(match_type, match_value);
CREATE INDEX IF NOT EXISTS idx_owner_blocklist_type ON owner_blocklist(match_type);

CREATE TABLE IF NOT EXISTS owner_blocklist_hits (
  id TEXT PRIMARY KEY,
  blocklist_id TEXT,
  match_type TEXT,
  match_value TEXT,
  context TEXT,
  subject_email TEXT,
  subject_phone TEXT,
  subject_name TEXT,
  subject_organization TEXT,
  enforcement TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_owner_blocklist_hits_created ON owner_blocklist_hits(created_at);

-- ── User-behavior learning (SOFT preference signals — architecture #12) ──
-- Saves / applies / dismisses-rejects nudge future matching toward what the
-- user values. SOFT preference learning only — never a hard filter. See
-- backend/services/behaviorLearning.js. Gated by BEHAVIOR_LEARNING_ENABLED.
CREATE TABLE IF NOT EXISTS behavior_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('saved', 'applied', 'dismissed', 'ignored')),
  opportunity_source TEXT,
  opportunity_categories TEXT,
  need_types TEXT,
  is_local INTEGER,
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_behavior_events_profile ON behavior_events(profile_id);
CREATE INDEX IF NOT EXISTS idx_behavior_events_profile_ts ON behavior_events(profile_id, ts);
