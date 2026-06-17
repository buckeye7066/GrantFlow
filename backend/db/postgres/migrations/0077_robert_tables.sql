-- 0077_robert_tables.sql
--
-- Postgres counterpart to 081_robert_tables.sql for Robert, GrantFlow's
-- funding-discovery agent. See that file for design notes. Idempotent:
-- IF NOT EXISTS on every object.

CREATE TABLE IF NOT EXISTS robert_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  mode TEXT NOT NULL DEFAULT 'observe'
    CHECK(mode IN ('observe','discover-sources','discover-opportunities','verify','ingest','match','recommend','full-cycle')),
  trigger TEXT NOT NULL DEFAULT 'manual'
    CHECK(trigger IN ('manual','scheduled','startup','admin-ui','api')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','completed','failed','cancelled')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
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
  summary_json JSONB DEFAULT '{}'::jsonb,
  error TEXT,
  created_by_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_robert_runs_started_at ON robert_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_robert_runs_status     ON robert_runs(status);
CREATE INDEX IF NOT EXISTS idx_robert_runs_mode       ON robert_runs(mode);

CREATE TABLE IF NOT EXISTS robert_source_candidates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_domain TEXT,
  source_type TEXT,
  source_scope TEXT,
  geography_state TEXT,
  geography_county TEXT,
  geography_city TEXT,
  applicant_types_json JSONB DEFAULT '[]'::jsonb,
  need_categories_json JSONB DEFAULT '[]'::jsonb,
  trust_score INTEGER DEFAULT 0,
  discovered_by TEXT,
  discovered_at TIMESTAMPTZ DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','suspended')),
  rejection_reason TEXT,
  evidence_json JSONB DEFAULT '{}'::jsonb,
  robots_allowed BOOLEAN DEFAULT TRUE,
  rate_limit_bucket TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_robert_source_candidates_url ON robert_source_candidates(source_url);
CREATE INDEX IF NOT EXISTS idx_robert_source_candidates_status ON robert_source_candidates(status);
CREATE INDEX IF NOT EXISTS idx_robert_source_candidates_domain ON robert_source_candidates(source_domain);

CREATE TABLE IF NOT EXISTS robert_opportunity_candidates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT,
  source_candidate_id TEXT,
  title TEXT,
  sponsor TEXT,
  description TEXT,
  application_url TEXT,
  source_url TEXT,
  deadline TEXT,
  deadline_type TEXT,
  amount_min DOUBLE PRECISION,
  amount_max DOUBLE PRECISION,
  amount_description TEXT,
  geography_json JSONB DEFAULT '{}'::jsonb,
  eligibility_json JSONB DEFAULT '[]'::jsonb,
  categories_json JSONB DEFAULT '[]'::jsonb,
  keywords_json JSONB DEFAULT '[]'::jsonb,
  applicant_types_json JSONB DEFAULT '[]'::jsonb,
  need_categories_json JSONB DEFAULT '[]'::jsonb,
  raw_payload_json JSONB DEFAULT '{}'::jsonb,
  extraction_method TEXT,
  confidence DOUBLE PRECISION DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(verification_status IN ('pending','verified','rejected','superseded')),
  verification_reasons_json JSONB DEFAULT '[]'::jsonb,
  policy_status TEXT,
  policy_rejection_reason TEXT,
  reality_status TEXT,
  reviewer_status TEXT,
  normalized_opportunity_json JSONB,
  existing_opportunity_id TEXT,
  ingested_opportunity_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_robert_oc_run            ON robert_opportunity_candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_robert_oc_source         ON robert_opportunity_candidates(source_candidate_id);
CREATE INDEX IF NOT EXISTS idx_robert_oc_verification   ON robert_opportunity_candidates(verification_status);
CREATE INDEX IF NOT EXISTS idx_robert_oc_app_url        ON robert_opportunity_candidates(application_url);
CREATE INDEX IF NOT EXISTS idx_robert_oc_source_url     ON robert_opportunity_candidates(source_url);

CREATE TABLE IF NOT EXISTS robert_profile_coverage (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  coverage_score DOUBLE PRECISION DEFAULT 0,
  known_matches_count INTEGER DEFAULT 0,
  accepted_matches_count INTEGER DEFAULT 0,
  review_matches_count INTEGER DEFAULT 0,
  zero_result_risk INTEGER DEFAULT 0,
  missing_need_categories_json JSONB DEFAULT '[]'::jsonb,
  missing_geographies_json JSONB DEFAULT '[]'::jsonb,
  recommended_search_queries_json JSONB DEFAULT '[]'::jsonb,
  recommended_source_types_json JSONB DEFAULT '[]'::jsonb,
  last_analyzed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_robert_profile_coverage_profile ON robert_profile_coverage(profile_id);

CREATE TABLE IF NOT EXISTS robert_profile_recommendations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT,
  robert_run_id TEXT,
  recommendation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(recommendation_status IN ('pending','delivered','viewed','accepted','declined','expired','superseded')),
  delivery_status TEXT NOT NULL DEFAULT 'queued'
    CHECK(delivery_status IN ('queued','delivered_live','delivered_on_login','dismissed','failed')),
  match_score DOUBLE PRECISION,
  match_decision TEXT,
  match_reasons_json JSONB DEFAULT '[]'::jsonb,
  missing_profile_fields_json JSONB DEFAULT '[]'::jsonb,
  why_found TEXT,
  search_query_used TEXT,
  source_candidate_id TEXT,
  opportunity_candidate_id TEXT,
  toast_title TEXT,
  toast_body TEXT,
  toast_priority TEXT DEFAULT 'normal',
  toast_shown_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  last_delivered_at TIMESTAMPTZ,
  delivery_attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
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
  window_start TIMESTAMPTZ DEFAULT NOW(),
  request_count INTEGER DEFAULT 0,
  last_request_at TIMESTAMPTZ,
  blocked_until TIMESTAMPTZ,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_robert_rate_limits_blocked ON robert_domain_rate_limits(blocked_until);
