/**
 * robertTypes.js
 *
 * Shared constants + shape helpers for Robert, GrantFlow's
 * funding-discovery agent. No runtime side effects — everything here is
 * pure data + tiny factories so unit tests can use these constants
 * directly.
 *
 * Robert never reimplements the canonical match engine, opportunity
 * policy, validator, reviewer, reality gate, link verification, or
 * ingestion service. These types just describe Robert's own discovery
 * + recommendation shapes; scoring + accept/reject decisions are
 * delegated to backend/services/matchEngine.computeMatchDecision and
 * the existing pipeline saver.
 */

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
export const ROBERT_MODES = Object.freeze({
  OBSERVE: 'observe',
  DISCOVER_SOURCES: 'discover-sources',
  DISCOVER_OPPORTUNITIES: 'discover-opportunities',
  VERIFY: 'verify',
  INGEST: 'ingest',
  MATCH: 'match',
  RECOMMEND: 'recommend',
  FULL_CYCLE: 'full-cycle',
  /**
   * AUDIT_PIPELINES (owner order 2026-08-21) — verify every funding source in
   * every profile's pipeline against four gates (REAL / RELATABLE / COVERS A
   * NEED / QUALIFIES), collapse duplicates to one surviving record, remove what
   * fails, and notate Amy so she can close the coverage gap the removal opens.
   * Implementation: `robertPipelineAudit.js`. There is no preview mode.
   */
  AUDIT_PIPELINES: 'audit-pipelines',
})
export const ROBERT_MODE_LIST = Object.freeze(Object.values(ROBERT_MODES))
export const DEFAULT_MODE = ROBERT_MODES.OBSERVE

export function isValidMode(value) {
  return ROBERT_MODE_LIST.includes(String(value || '').toLowerCase())
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------
export const ROBERT_TRIGGERS = Object.freeze({
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
  STARTUP: 'startup',
  ADMIN_UI: 'admin-ui',
  API: 'api',
})

// ---------------------------------------------------------------------------
// Run / candidate / recommendation statuses (mirror DB CHECKs)
// ---------------------------------------------------------------------------
export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

export const SOURCE_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
})

export const VERIFICATION_STATUS = Object.freeze({
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
})

export const RECOMMENDATION_STATUS = Object.freeze({
  PENDING: 'pending',
  DELIVERED: 'delivered',
  VIEWED: 'viewed',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded',
})

export const DELIVERY_STATUS = Object.freeze({
  QUEUED: 'queued',
  DELIVERED_LIVE: 'delivered_live',
  DELIVERED_ON_LOGIN: 'delivered_on_login',
  DISMISSED: 'dismissed',
  FAILED: 'failed',
})

export const TOAST_PRIORITY = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
})

// ---------------------------------------------------------------------------
// Source types + scopes
// ---------------------------------------------------------------------------
export const SOURCE_TYPES = Object.freeze([
  'federal_portal',
  'state_grant_portal',
  'county_portal',
  'city_portal',
  'community_foundation',
  'private_foundation',
  'corporate_giving',
  'school_portal',
  'university_scholarship_portal',
  'hospital_charity_care',
  'utility_assistance',
  'disability_assistance',
  'veteran_organization',
  'faith_based_foundation',
  'fire_department_grants',
  'rural_development',
  'education_directory',
  'nonprofit_directory',
  'benefits_directory',
])

export const SOURCE_SCOPES = Object.freeze([
  'federal',
  'state',
  'county',
  'city',
  'regional',
  'national',
  'international',
])

// ---------------------------------------------------------------------------
// Rejection reason codes (per spec)
// ---------------------------------------------------------------------------
export const REJECTION_REASONS = Object.freeze({
  NO_REAL_URL: 'no_real_url',
  PLACEHOLDER_URL: 'placeholder_url',
  PLACEHOLDER_TEXT: 'placeholder_text',
  LOAN_LIKE: 'loan_like',
  MATCHING_FUNDS: 'matching_funds',
  EXPIRED_DEADLINE: 'expired_deadline',
  DEAD_LINK: 'dead_link',
  SEARCH_ENGINE_URL_FOR_DIRECT_OPP: 'search_engine_url_for_direct_opp',
  MISSING_TITLE: 'missing_title',
  MISSING_SPONSOR: 'missing_sponsor',
  MISSING_APPLICATION_PATH: 'missing_application_path',
  DUPLICATE: 'duplicate',
  LOW_SOURCE_TRUST: 'low_source_trust',
  INACCESSIBLE_PAGE: 'inaccessible_page',
  LOGIN_REQUIRED: 'login_required',
  CAPTCHA_BLOCKED: 'captcha_blocked',
  UNSUPPORTED_FILE_TYPE: 'unsupported_file_type',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  NOT_FUNDING: 'not_funding',
  DIRECTORY_ONLY: 'directory_only',
  PROFILE_MISMATCH: 'profile_mismatch',
  UNSAFE_OR_UNRELIABLE_SOURCE: 'unsafe_or_unreliable_source',
})

// ---------------------------------------------------------------------------
// Match decision values (mirror matchEngine + a Robert-only one for "needs more profile data")
// ---------------------------------------------------------------------------
export const MATCH_DECISION = Object.freeze({
  ACCEPT: 'ACCEPT',
  REVIEW: 'REVIEW',
  REJECT: 'REJECT',
  NEEDS_PROFILE_DATA: 'NEEDS_PROFILE_DATA',
})

// ---------------------------------------------------------------------------
// Coverage signal categories
// ---------------------------------------------------------------------------
export const COVERAGE_RISKS = Object.freeze({
  ZERO_RESULTS: 'zero_results',
  STALE_RESULTS: 'stale_results',
  WEAK_MATCH_COVERAGE: 'weak_match_coverage',
  NARROW_GEOGRAPHY: 'narrow_geography',
  MISSING_LOCAL: 'missing_local_opportunities',
  MISSING_STATE: 'missing_state_opportunities',
  MISSING_NATIONAL: 'missing_national_opportunities',
  MISSING_STUDENT: 'missing_student_opportunities',
  MISSING_FAITH: 'missing_faith_opportunities',
  MISSING_VOLUNTEER_FIRE: 'missing_volunteer_fire_opportunities',
  MISSING_SMALL_BUSINESS: 'missing_small_business_opportunities',
  MISSING_NONPROFIT: 'missing_nonprofit_opportunities',
})

// ---------------------------------------------------------------------------
// Shape factories
// ---------------------------------------------------------------------------

export function makeSearchPlan({
  profile_id,
  applicant_type = null,
  location_scope = null,
  need_category = null,
  search_query,
  source_types = [],
  trusted_domains = [],
  exclude_terms = [],
  expected_evidence = [],
  priority = 50,
  reason = '',
} = {}) {
  if (!search_query) throw new Error('makeSearchPlan: search_query is required')
  return {
    profile_id: profile_id ?? null,
    applicant_type,
    location_scope,
    need_category,
    search_query,
    source_types: Array.isArray(source_types) ? source_types : [],
    trusted_domains: Array.isArray(trusted_domains) ? trusted_domains : [],
    exclude_terms: Array.isArray(exclude_terms) ? exclude_terms : [],
    expected_evidence: Array.isArray(expected_evidence) ? expected_evidence : [],
    priority: clamp(priority, 0, 100),
    reason: String(reason || ''),
  }
}

export function makeSourceCandidate({
  source_name,
  source_url,
  source_domain = null,
  source_type = null,
  source_scope = null,
  geography_state = null,
  geography_county = null,
  geography_city = null,
  applicant_types = [],
  need_categories = [],
  trust_score = 0,
  discovered_by = 'robert',
  status = SOURCE_STATUS.PENDING,
  evidence = {},
  robots_allowed = true,
} = {}) {
  if (!source_name) throw new Error('makeSourceCandidate: source_name is required')
  if (!source_url) throw new Error('makeSourceCandidate: source_url is required')
  return {
    source_name: String(source_name).trim(),
    source_url: String(source_url).trim(),
    source_domain: source_domain || extractDomain(source_url),
    source_type,
    source_scope,
    geography_state,
    geography_county,
    geography_city,
    applicant_types: Array.isArray(applicant_types) ? applicant_types : [],
    need_categories: Array.isArray(need_categories) ? need_categories : [],
    trust_score: clamp(trust_score, 0, 100),
    discovered_by,
    status,
    evidence: evidence && typeof evidence === 'object' ? evidence : {},
    robots_allowed: robots_allowed !== false,
  }
}

export function makeOpportunityCandidate({
  run_id = null,
  source_candidate_id = null,
  title = null,
  sponsor = null,
  description = null,
  application_url = null,
  source_url = null,
  deadline = null,
  deadline_type = null,
  amount_min = null,
  amount_max = null,
  amount_description = null,
  geography = {},
  eligibility = [],
  categories = [],
  keywords = [],
  applicant_types = [],
  need_categories = [],
  raw_payload = {},
  extraction_method = null,
  confidence = 0,
} = {}) {
  return {
    run_id,
    source_candidate_id,
    title: trimOrNull(title),
    sponsor: trimOrNull(sponsor),
    description: trimOrNull(description),
    application_url: trimOrNull(application_url),
    source_url: trimOrNull(source_url),
    deadline: trimOrNull(deadline),
    deadline_type: trimOrNull(deadline_type),
    amount_min: numberOrNull(amount_min),
    amount_max: numberOrNull(amount_max),
    amount_description: trimOrNull(amount_description),
    geography: geography && typeof geography === 'object' ? geography : {},
    eligibility: Array.isArray(eligibility) ? eligibility : [],
    categories: Array.isArray(categories) ? categories : [],
    keywords: Array.isArray(keywords) ? keywords : [],
    applicant_types: Array.isArray(applicant_types) ? applicant_types : [],
    need_categories: Array.isArray(need_categories) ? need_categories : [],
    raw_payload: raw_payload && typeof raw_payload === 'object' ? raw_payload : {},
    extraction_method: trimOrNull(extraction_method),
    confidence: clamp(Number(confidence) || 0, 0, 1),
    verification_status: VERIFICATION_STATUS.PENDING,
    verification_reasons: [],
  }
}

export function makeRecommendation({
  profile_id,
  opportunity_id,
  robert_run_id = null,
  match_score = null,
  match_decision = null,
  match_reasons = [],
  missing_profile_fields = [],
  why_found = '',
  search_query_used = '',
  source_candidate_id = null,
  opportunity_candidate_id = null,
  toast_title = null,
  toast_body = null,
  toast_priority = TOAST_PRIORITY.NORMAL,
} = {}) {
  if (!profile_id) throw new Error('makeRecommendation: profile_id is required')
  return {
    profile_id,
    opportunity_id,
    robert_run_id,
    recommendation_status: RECOMMENDATION_STATUS.PENDING,
    delivery_status: DELIVERY_STATUS.QUEUED,
    match_score: numberOrNull(match_score),
    match_decision,
    match_reasons: Array.isArray(match_reasons) ? match_reasons : [],
    missing_profile_fields: Array.isArray(missing_profile_fields) ? missing_profile_fields : [],
    why_found: String(why_found || ''),
    search_query_used: String(search_query_used || ''),
    source_candidate_id,
    opportunity_candidate_id,
    toast_title: trimOrNull(toast_title),
    toast_body: trimOrNull(toast_body),
    toast_priority: TOAST_PRIORITY[String(toast_priority || '').toUpperCase()] || TOAST_PRIORITY.NORMAL,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

export function trimOrNull(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s.length === 0 ? null : s
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function extractDomain(url) {
  if (!url || typeof url !== 'string') return null
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`)
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}
