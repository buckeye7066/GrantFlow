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

// Grant statuses
//
// Canonical pipeline (RC-13) re-exported from the shared module. The list
// here MUST stay a superset of every status the UI exposes and every status
// the DB CHECK accepts; otherwise PATCH /api/grants/:id/status will reject
// stage transitions the user just made via drag-and-drop.
//
// Source of truth: shared/pipelineStages.js. Consumed by routes/grants.js,
// services/relevanceFilterRules.js, and other API validators.
import { PIPELINE_STAGE_ALL, PIPELINE_STAGES, PIPELINE_STAGE_ALIASES } from '../../shared/pipelineStages.js'
export const GRANT_STATUSES = [...PIPELINE_STAGE_ALL]
export const GRANT_STATUSES_CANONICAL = PIPELINE_STAGES
export const GRANT_STATUS_ALIASES = PIPELINE_STAGE_ALIASES;
