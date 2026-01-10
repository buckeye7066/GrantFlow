/**
 * Shared Constants
 * 
 * Centralized constants used across the backend application
 */

// Admin Configuration
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'buckeye7066@gmail.com'

/**
 * Check if an email belongs to an admin user
 * @param {string} email - Email address to check
 * @returns {boolean} True if the email is an admin email
 */
export function isAdminEmail(email) {
  if (!email || typeof email !== 'string') {
    return false
  }
  return email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase()
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
export const MAX_JSON_BODY_SIZE = '50mb';

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
  'comprehensive',
  'national',
  'national_zip_scan',
  'item_search',
  'avatar_lookup',
  'document_ingest',
  'pipeline_automation',
  'profile_enrichment'
];

// Grant statuses
export const GRANT_STATUSES = [
  'discovered',
  'interested',
  'drafting',
  'app_prep',
  'revision',
  'submitted',
  'under_review',
  'awarded',
  'rejected',
  'closed',
  'archived'
];
