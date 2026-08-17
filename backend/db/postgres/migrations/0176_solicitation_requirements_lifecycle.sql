-- Postgres twin of SQLite migration 171.
-- Slices 7-9: durable, versioned solicitation text + requirements, grounded
-- draft coverage, and an explicit application lifecycle aggregate root.

CREATE TABLE IF NOT EXISTS opportunity_solicitations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('nofo','rfp','amendment','other')),
  source_url TEXT,
  title TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_opportunity_solicitations_subject
  ON opportunity_solicitations(profile_id, opportunity_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_opportunity_solicitations_source
  ON opportunity_solicitations(profile_id, opportunity_id, source_kind, COALESCE(source_url, ''));

CREATE TABLE IF NOT EXISTS solicitation_versions (
  id TEXT PRIMARY KEY,
  solicitation_id TEXT NOT NULL REFERENCES opportunity_solicitations(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  source_filename TEXT,
  mime_type TEXT,
  extracted_chars INTEGER NOT NULL CHECK(extracted_chars >= 0),
  chunk_count INTEGER NOT NULL CHECK(chunk_count > 0),
  published_at TIMESTAMPTZ,
  effective_at TIMESTAMPTZ,
  is_amendment BOOLEAN NOT NULL DEFAULT FALSE,
  supersedes_version_id TEXT REFERENCES solicitation_versions(id) ON DELETE RESTRICT,
  ingestion_status TEXT NOT NULL DEFAULT 'complete'
    CHECK(ingestion_status IN ('complete','failed')),
  validation_errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(solicitation_id, version_number),
  UNIQUE(solicitation_id, source_sha256)
);
CREATE INDEX IF NOT EXISTS idx_solicitation_versions_latest
  ON solicitation_versions(solicitation_id, version_number DESC);

CREATE TABLE IF NOT EXISTS solicitation_chunks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES solicitation_versions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  char_start INTEGER NOT NULL CHECK(char_start >= 0),
  char_end INTEGER NOT NULL CHECK(char_end >= char_start),
  page_start INTEGER,
  page_end INTEGER,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(version_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_solicitation_chunks_version
  ON solicitation_chunks(version_id, chunk_index);

CREATE TABLE IF NOT EXISTS solicitation_requirements (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES solicitation_versions(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  requirement_type TEXT NOT NULL CHECK(requirement_type IN (
    'eligibility','submission','narrative','budget','document','deadline',
    'format','evaluation','reporting','compliance','contact','other'
  )),
  title TEXT,
  requirement_text TEXT NOT NULL,
  normalized_value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  mandatory BOOLEAN NOT NULL DEFAULT TRUE,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','withdrawn','superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(version_id, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_solicitation_requirements_version
  ON solicitation_requirements(version_id, requirement_type, mandatory);

CREATE TABLE IF NOT EXISTS requirement_citations (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES solicitation_requirements(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES solicitation_chunks(id) ON DELETE RESTRICT,
  quote_text TEXT NOT NULL,
  char_start INTEGER NOT NULL CHECK(char_start >= 0),
  char_end INTEGER NOT NULL CHECK(char_end >= char_start),
  page_number INTEGER,
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_requirement_citations_requirement
  ON requirement_citations(requirement_id);

CREATE TABLE IF NOT EXISTS solicitation_amendment_diffs (
  id TEXT PRIMARY KEY,
  solicitation_id TEXT NOT NULL REFERENCES opportunity_solicitations(id) ON DELETE CASCADE,
  from_version_id TEXT NOT NULL REFERENCES solicitation_versions(id) ON DELETE RESTRICT,
  to_version_id TEXT NOT NULL REFERENCES solicitation_versions(id) ON DELETE RESTRICT,
  canonical_key TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN ('added','removed','modified')),
  before_json JSONB,
  after_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(from_version_id, to_version_id, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_solicitation_amendment_to_version
  ON solicitation_amendment_diffs(to_version_id, change_type);

CREATE TABLE IF NOT EXISTS application_lifecycle_subjects (
  application_id TEXT PRIMARY KEY REFERENCES grant_applications(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT REFERENCES funding_opportunities(id) ON DELETE SET NULL,
  pipeline_grant_id TEXT REFERENCES grants(id) ON DELETE SET NULL,
  canonical_task_id TEXT REFERENCES application_tasks(id) ON DELETE SET NULL,
  solicitation_id TEXT REFERENCES opportunity_solicitations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_application_lifecycle_subject
  ON application_lifecycle_subjects(profile_id, opportunity_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_lifecycle_task
  ON application_lifecycle_subjects(canonical_task_id)
  WHERE canonical_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS draft_requirement_coverage (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES grant_applications(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES application_drafts(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES solicitation_requirements(id) ON DELETE CASCADE,
  coverage_status TEXT NOT NULL CHECK(coverage_status IN ('addressed','partial','missing','not_applicable')),
  response_excerpt TEXT,
  applicant_evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  requirement_citations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  unsupported_claims_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(draft_id, requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_draft_requirement_coverage_application
  ON draft_requirement_coverage(application_id, coverage_status);

CREATE TABLE IF NOT EXISTS application_outcome_evidence (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES grant_applications(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK(outcome IN ('awarded','declined','waitlisted','withdrawn')),
  response_received_at TIMESTAMPTZ NOT NULL,
  confirmation_reference TEXT,
  attested_by_user_id TEXT NOT NULL,
  attested_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  revoked_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(application_id, evidence_sha256)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_outcome_active
  ON application_outcome_evidence(application_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_application_outcome_profile
  ON application_outcome_evidence(profile_id, response_received_at DESC);

CREATE OR REPLACE FUNCTION protect_application_outcome_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'application outcome evidence is append-only'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    OLD.status = 'active'
    AND NEW.status = 'revoked'
    AND OLD.revoked_at IS NULL
    AND OLD.revocation_reason IS NULL
    AND OLD.revoked_by_user_id IS NULL
    AND NEW.revoked_at IS NOT NULL
    AND NULLIF(BTRIM(NEW.revocation_reason), '') IS NOT NULL
    AND NULLIF(BTRIM(NEW.revoked_by_user_id), '') IS NOT NULL
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.application_id IS NOT DISTINCT FROM OLD.application_id
    AND NEW.profile_id IS NOT DISTINCT FROM OLD.profile_id
    AND NEW.document_id IS NOT DISTINCT FROM OLD.document_id
    AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome
    AND NEW.response_received_at IS NOT DISTINCT FROM OLD.response_received_at
    AND NEW.confirmation_reference IS NOT DISTINCT FROM OLD.confirmation_reference
    AND NEW.attested_by_user_id IS NOT DISTINCT FROM OLD.attested_by_user_id
    AND NEW.attested_at IS NOT DISTINCT FROM OLD.attested_at
    AND NEW.evidence_sha256 IS NOT DISTINCT FROM OLD.evidence_sha256
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'application outcome evidence is append-only; only active-to-revoked is permitted'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_application_outcome_evidence_no_delete
  ON application_outcome_evidence;
DROP TRIGGER IF EXISTS trg_application_outcome_evidence_revoke_only
  ON application_outcome_evidence;
CREATE TRIGGER trg_application_outcome_evidence_revoke_only
BEFORE UPDATE OR DELETE ON application_outcome_evidence
FOR EACH ROW EXECUTE FUNCTION protect_application_outcome_evidence();
