/**
 * Shared Constants
 * 
 * Centralized constants used across the backend application
 */

// Admin Configuration
// Keep a stable default so production doesn't lock out the operator when ADMIN_EMAIL
// is misconfigured. Additional admins can be added via ADMIN_EMAILS (comma-separated).
const DEFAULT_ADMIN_EMAIL = 'buckeye7066@gmail.com'
export const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL)
export const ADMIN_EMAILS = Object.freeze(
  Array.from(
    new Set(
      [
        ADMIN_EMAIL,
        DEFAULT_ADMIN_EMAIL,
        ...(String(process.env.ADMIN_EMAILS || '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)),
      ].map((v) => String(v).trim().toLowerCase()).filter(Boolean),
    ),
  ),
)

/**
 * Check if an email belongs to an admin user
 * @param {string} email - Email address to check
 * @returns {boolean} True if the email is an admin email
 */
export function isAdminEmail(email) {
  if (!email || typeof email !== 'string') {
    return false
  }
  const normalized = email.trim().toLowerCase()
  return ADMIN_EMAILS.includes(normalized)
}

// Pagination defaults
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 1000;
export const MIN_PAGE_LIMIT = 1;
export const DEFAULT_OFFSET = 0;

// Rate limiting
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const RATE_LIMIT_MAX_REQUESTS = 100;
export const MUTATION_RATE_LIMIT_MAX = 500; // Temporarily increased for batch operations

// OpenAI configuration
export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
export const OPENAI_TIMEOUT_MS = 60000; // 60 seconds
export const MAX_OPENAI_TOKENS = 4000;
export const MAX_PROMPT_LENGTH = 50000;

// OAuth configuration
export const OAUTH_STATE_EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes

// File upload limits
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_JSON_BODY_SIZE = '5mb';

// Billing constants
export const BILLING_TIERS = {
  FREE: 'free',
  BASIC: 'basic',
  PRO: 'pro',
  ENTERPRISE: 'enterprise'
};

// Discount types
export const DISCOUNT_TYPES = {
  NONE: 'none',
  STUDENT: 'student',
  MINISTER: 'minister'
};

// Crawler job types
// Crawler job types — single source of truth. MUST stay in sync with:
//   * backend/db/postgres/migrations (the crawler_jobs.type CHECK constraint, latest 0069)
//   * backend/services/crawlerJobCreation.js VALID_TYPES (imports this list)
//   * backend/services/crawlerDispatcher.js HANDLERS
export const CRAWLER_JOB_TYPES = [
  'anya_match_scout',
  'avatar_lookup',
  'clinical_trials',
  'comprehensive',
  'curated_benefits',
  'document_ingest',
  'ecf_benefits',
  'ecf_hcbs',
  'foundation_990',
  'government_funding',
  'health_resources',
  'item_gift_search',
  'item_matching',
  'item_search',
  'live_search',
  'local',
  'local_funding',
  'national',
  'national_zip_scan',
  'pipeline_automation',
  'portal_check',
  'profile_enrichment',
  'scholarship',
  'special_needs',
  'student_bridge_funding',
  'student_grants',
];

export const CRAWLER_JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]

// Grant (pipeline) statuses — single source of truth for status validation.
//
// RC-13 (PR #505): canonicalised through shared/pipelineStages.js so backend,
// frontend (KanbanBoard), and the DB CHECK all consume the same list and stop
// drifting. The shared module already accepts every status migration 0032
// expanded the CHECK to (discovery, auto_applied, application_prep, revision,
// portal, pending_review, report, declined_no_review, closed, app_prep,
// under_review, rejected, deadline_passed) as legacy aliases mapped to one of
// the 11 canonical stages, so existing rows continue to validate and historic
// pipelines render correctly.
//
// MUST stay in sync with:
//   * backend/db/postgres/migrations/0032_expand_grants_status_check.sql + 0072
//   * backend/db/migrations/076_grants_status_canonical_pipeline.mjs
//   * src/components/pipeline/KanbanBoard.jsx STATUSES (consumes the shared module)
//
// Drift between these is what produced the "pipeline totals don't match" report.
import {
  PIPELINE_STAGE_ALL,
  PIPELINE_STAGES,
  PIPELINE_STAGE_ALIASES,
} from '../../shared/pipelineStages.js'
export const GRANT_STATUSES = [...PIPELINE_STAGE_ALL]
export const GRANT_STATUSES_CANONICAL = PIPELINE_STAGES
export const GRANT_STATUS_ALIASES = PIPELINE_STAGE_ALIASES
