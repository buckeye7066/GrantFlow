-- 081_robert_tables.sql
--
-- Persistent tables for Robert, GrantFlow's funding-discovery agent.
-- Robert delegates to the canonical match engine, opportunity policy,
-- validator, reviewer, reality gate, link verification, and ingestion
-- service — these tables only track Robert's own discovery, candidate
-- review, coverage analysis, and per-profile recommendation queue.
--
-- Tables:
--   robert_runs                  — orchestrating run history
--   robert_source_candidates     — discovered source pages awaiting review
--   robert_opportunity_candidates — extracted opportunity candidates
--   robert_profile_coverage      — per-profile coverage / gap snapshot
--   robert_profile_recommendations — pending profile-specific suggestions
--   robert_domain_rate_limits    — per-domain fetch governor
--
-- Idempotent — every CREATE uses IF NOT EXISTS so re-applying is safe.

CREATE TABLE IF NOT EXISTS robert_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL DEFAULT 'observe'
    CHECK(mode IN ('observe','discover-sources','discover-opportunities','verify','ingest','match','recommend','full-cycle')),
  trigger TEXT NOT NULL DEFAULT 'manual'
    CHECK(trigger IN ('manual','scheduled','startup','admin-ui','api')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','completed','failed','cancelled')),
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

CREATE TABLE IF NOT EXISTS robert_source_candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_domain TEXT,
  source_type TEXT,
  source_scope TEXT,                 -- federal | state | county | city | regional | national | international
  geography_state TEXT,
  geography_county TEXT,
  geography_city TEXT,
  applicant_types_json TEXT DEFAULT '[]',
  need_categories_json TEXT DEFAULT '[]',
  trust_score INTEGER DEFAULT 0,     -- 0..100
  discovered_by TEXT,
  discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_checked_at DATETIME,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','suspended')),
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
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(verification_status IN ('pending','verified','rejected','superseded')),
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
  zero_result_risk INTEGER DEFAULT 0,            -- 0..100
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
  opportunity_id TEXT,                         -- references funding_opportunities(id) once ingested
  robert_run_id TEXT,
  recommendation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(recommendation_status IN ('pending','delivered','viewed','accepted','declined','expired','superseded')),
  delivery_status TEXT NOT NULL DEFAULT 'queued'
    CHECK(delivery_status IN ('queued','delivered_live','delivered_on_login','dismissed','failed')),
  match_score REAL,
  match_decision TEXT,                         -- ACCEPT | REVIEW | REJECT | NEEDS_PROFILE_DATA
  match_reasons_json TEXT DEFAULT '[]',
  missing_profile_fields_json TEXT DEFAULT '[]',
  why_found TEXT,
  search_query_used TEXT,
  source_candidate_id TEXT,
  opportunity_candidate_id TEXT,
  toast_title TEXT,
  toast_body TEXT,
  toast_priority TEXT DEFAULT 'normal',        -- low | normal | high
  toast_shown_at DATETIME,
  viewed_at DATETIME,
  accepted_at DATETIME,
  declined_at DATETIME,
  last_delivered_at DATETIME,
  delivery_attempts INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Prevent duplicate pending/delivered recommendations for the same profile + opportunity.
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
