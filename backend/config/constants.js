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
export const CRAWLER_JOB_TYPES = [
  'local',
  'scholarship',
  'health_resources',
  'comprehensive',
  'national',
  'item_search',
  'item_gift_search',
  'avatar_lookup',
  'document_ingest',
  'pipeline_automation',
  'profile_enrichment',
  'curated_benefits',
  'government_funding',
  'student_grants',
  'ecf_benefits',
  'special_needs',
  'local_funding',
  'item_matching',
  'portal_check',
  'student_bridge_funding',
];

export const CRAWLER_JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]

// Grant (pipeline) statuses — single source of truth.
// MUST stay in sync with:
//   * backend/db/postgres/migrations/0032_expand_grants_status_check.sql
//     (Postgres CHECK constraint)
//   * src/components/pipeline/KanbanBoard.jsx STATUSES
//     (every status listed here MUST render in some column, never silently
//     filtered — per the project rule "Counts displayed in the UI must map
//     1:1 to backend response fields.")
//
// Drift between this list and the UI column list is what produced the
// "pipeline totals don't match what's in the pipeline" user report:
// the API would 400 a valid UI status, or the UI would accept a status
// from the DB it had no column for. Keep them aligned.
export const GRANT_STATUSES = [
  // Current UI stages (post-migration 0032)
  'discovery',
  'discovered',
  'interested',
  'auto_applied',
  'drafting',
  'application_prep',
  'revision',
  'portal',
  'submitted',
  'pending_review',
  'follow_up',
  'awarded',
  'report',
  'declined_no_review',
  'declined',
  'closed',
  // Legacy stages preserved for backward compatibility with rows written
  // before migration 0032. New writes should prefer the current names
  // above, but reads must accept these so historical pipeline rows are
  // still routable to a column (no silent drops).
  'app_prep',
  'under_review',
  'rejected',
  'archived',
];

// Legacy → current canonical name. Used by UI helpers to normalize a
// status before bucketing into Kanban columns so legacy data still
// renders in the right place.
export const GRANT_STATUS_ALIASES = Object.freeze({
  app_prep: 'application_prep',
  under_review: 'pending_review',
  rejected: 'declined',
  archived: 'closed',
});
