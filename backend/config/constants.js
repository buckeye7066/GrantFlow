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
  'comprehensive',
  'curated_benefits',
  'document_ingest',
  'ecf_benefits',
  'government_funding',
  'health_resources',
  'item_gift_search',
  'item_matching',
  'item_search',
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
// MUST stay in sync with:
//   * backend/db/postgres/migrations/0032_expand_grants_status_check.sql
//     (the Postgres CHECK constraint — anything the DB will store, the API
//     must accept, or PATCH /grants/:id/status 400s a valid drag-and-drop)
//   * src/components/pipeline/KanbanBoard.jsx STATUSES
//     (every status here must render in some column — per the product rule
//     "counts displayed in the UI must map 1:1 to backend response fields")
// Drift here is what produced the "pipeline totals don't match" report.
export const GRANT_STATUSES = [
  // Current UI stages (post-migration 0032 — match KanbanBoard exactly)
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
  // before migration 0032. Reads must accept these so historical pipeline
  // rows remain routable to a column (no silent drops).
  'app_prep',
  'under_review',
  'rejected',
  'archived',
  // Auto-transition terminal status written by deadlineExpiryService when an
  // opportunity's deadline passes. Must be accepted by PATCH /grants/:id/status
  // and routed to a column in KanbanBoard, or deadline transitions either 400
  // (constraint reject) or vanish from the pipeline (silent drop).
  'deadline_passed'
];
