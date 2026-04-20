/**
 * Opportunity Policy Module
 *
 * Single source of truth for all compliance checks applied to funding opportunities
 * before they are returned by crawlers, stored in the DB, or served by listing APIs.
 *
 * Every path that emits an opportunity MUST call enforceOpportunityPolicy() and
 * drop results where { ok: false }.
 *
 * Rules enforced:
 *  1. Valid real URL — at least one of url/source_url/application_url must be a valid
 *     http/https URL with no placeholder domains.
 *  2. Not a loan — no loan-type schema fields or loan keyword patterns.
 *  3. Not matching-funds — no requires_match/match_percentage schema fields or keyword patterns.
 *  4. Not placeholder content — title/description must not be stub text.
 */

import { isValidHttpUrl } from './crawlerOpportunityContract.js'

// ─── Module-level rejection counters ────────────────────────────────────────

/** @type {Record<string, number>} */
const _rejectionCounts = {}

export function getPolicyRejectionCounts() {
  return { ..._rejectionCounts }
}

export function resetPolicyRejectionCounts() {
  for (const key of Object.keys(_rejectionCounts)) delete _rejectionCounts[key]
}

/** Bump a rejection reason into target or module-level counts. */
function bumpCount(reason, targetCounts = null) {
  const dest = targetCounts != null ? targetCounts : _rejectionCounts
  dest[reason] = (dest[reason] ?? 0) + 1
}

// ─── PLACEHOLDER DOMAINS ─────────────────────────────────────────────────────

const PLACEHOLDER_HOSTNAMES = new Set([
  'example.com',
  'example.org',
  'example.gov',
  'example.net',
  'placeholder.com',
  'placeholder',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
])

/**
 * Canonical list of opportunity source slugs that are always treated as
 * fake/synthetic/template content. Scripts and production cleanup paths MUST
 * pull from here instead of hard-coding their own lists, so adding a new
 * fake-source category only needs one edit.
 */
export const FAKE_OPPORTUNITY_SOURCES = Object.freeze([
  'comprehensive_crawler',
  'synthetic',
  'template',
  'fake',
  'example',
])

/**
 * Returns SQL LIKE patterns (wrapped in %) for every known placeholder host,
 * so DB cleanup scripts can purge placeholder URLs without hard-coding.
 *
 * Example:  ["%example.com%", "%example.org%", ...]
 */
export function getPlaceholderUrlSqlPatterns() {
  return [...PLACEHOLDER_HOSTNAMES].map((host) => `%${host}%`)
}

/** Expose the canonical placeholder host set as a frozen array for callers. */
export function getPlaceholderHostnames() {
  return [...PLACEHOLDER_HOSTNAMES]
}

/** Returns true if the URL resolves to a known placeholder/test domain. */
function isPlaceholderHostname(url) {
  if (typeof url !== 'string' || !url.trim()) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      PLACEHOLDER_HOSTNAMES.has(host) ||
      [...PLACEHOLDER_HOSTNAMES].some((ph) => host.endsWith('.' + ph))
    )
  } catch {
    return false
  }
}

// ─── LOAN-LIKE DETECTION ─────────────────────────────────────────────────────

const LOAN_OPP_TYPES = new Set(['loan', 'loan_program', 'microloan'])

/** Phrase/pattern that indicate a loan product (avoids false positives on "financing" in grant context). */
const LOAN_PHRASE_RX = [
  /\bloan\s+(program|application|fund)\b/i,
  /\bmicroloan\b/i,
  /\b(?:apr|annual percentage rate)\b/i,
  /\bcredit\s+line\b/i,
  /\brevolving\s+credit\b/i,
  /\binterest\s+rate\b/i,
  /\bmonthly\s+payment\b/i,
  /\bborrower\b/i,
  /\brepay\s+(the\s+)?loan\b/i,
  /\bloan\s+repayment\s+(schedule|terms)\b/i,
  /\brepayment\s+(of\s+)?(the\s+)?(loan|funds?)\b/i,
]

/** Grant-friendly contexts: mention of loans in assistance/forgiveness context — do not treat as loan product. */
const LOAN_ASSISTANCE_RX = [
  /\bloan\s+repayment\s+assistance\b/i,
  /\bloan\s+forgiveness\b/i,
  /\bstudent\s+loan\s+(forgiveness|repayment\s+assistance)\b/i,
  /\balternatives?\s+to\s+(traditional\s+)?financing\b/i,
  /\bdown\s+payment\s+assistance\b/i,
]

/** Matching-fund keyword patterns. */
const MATCH_KEYWORD_RX = [
  /matching funds/,
  /match required/,
  /cost.?share/,
  /1:1 match/,
  /dollar.?for.?dollar/,
]

/**
 * Returns true if the opportunity is a loan, microloan, or financing product.
 * Uses schema fields and phrase-based heuristics; exempts grant contexts (e.g. loan forgiveness, repayment assistance).
 */
export function isLoanLike(opp) {
  if (!opp || typeof opp !== 'object') return false
  if (opp.is_loan === true) return true
  const oppType = String(opp.opportunity_type || '').toLowerCase().trim()
  if (LOAN_OPP_TYPES.has(oppType)) return true
  const text =
    `${opp.title || ''} ${opp.description || ''} ${opp.eligibility || ''} ${opp.eligibility_criteria || ''}`.toLowerCase()
  if (LOAN_ASSISTANCE_RX.some((rx) => rx.test(text))) return false
  return LOAN_PHRASE_RX.some((rx) => rx.test(text))
}

/**
 * Returns true if the opportunity requires matching funds or a cost-share contribution.
 * Checks schema fields AND keyword heuristics.
 */
export function isMatchingFunds(opp) {
  if (!opp || typeof opp !== 'object') return false
  if (opp.requires_match === true) return true
  if (typeof opp.match_percentage === 'number' && opp.match_percentage > 0) return true
  const text =
    `${opp.title || ''} ${opp.description || ''} ${opp.eligibility || ''} ${opp.eligibility_criteria || ''}`.toLowerCase()
  return MATCH_KEYWORD_RX.some((rx) => rx.test(text))
}

// ─── PLACEHOLDER TEXT DETECTION ──────────────────────────────────────────────

const PLACEHOLDER_TEXT_PATTERNS = [
  /\blorem\b/i,
  /\bipsum\b/i,
  /\bcoming\s+soon\b/i,
  /\bplaceholder\b/i,
  /\btbd\b/i,
  /\btest opportunity\b/i,
  /\bsample opportunity\b/i,
  /\bfoo bar\b/i,
  /^test$/i,
  /\bstub\b/i,
  /\bexample\.com\b/i,
  /\bexample\.org\b/i,
]

/**
 * Returns true if the opportunity appears to be stub/placeholder content.
 * Checks title and description text fields.
 */
export function isPlaceholderOpportunity(opp) {
  if (!opp || typeof opp !== 'object') return false
  const title = String(opp.title || opp.name || '').trim()
  const desc = String(opp.description || opp.summary || '').trim()

  // Missing or trivially short title
  if (!title || title.length < 3) return true

  const haystack = `${title} ${desc}`.toLowerCase()
  return PLACEHOLDER_TEXT_PATTERNS.some((rx) => rx.test(haystack))
}

// ─── URL VALIDATION ───────────────────────────────────────────────────────────

/**
 * Returns true iff `url` is a valid http/https URL pointing to a real (non-placeholder) host.
 * Alias for isValidHttpUrl from crawlerOpportunityContract with identical semantics.
 */
export function isValidRealUrl(url) {
  if (!isValidHttpUrl(url)) return false
  return !isPlaceholderHostname(url)
}

/**
 * Returns the first real URL from an opportunity object, or null.
 */
export function pickRealUrl(opp) {
  for (const field of ['url', 'application_url', 'source_url', 'evidence_url']) {
    if (isValidRealUrl(opp?.[field])) return opp[field]
  }
  return null
}

// ─── POLICY ORCHESTRATOR ──────────────────────────────────────────────────────

// ─── EXPIRATION DETECTION ────────────────────────────────────────────────────

/**
 * Returns true if the opportunity has a fixed deadline that has passed.
 * Rolling deadlines and opportunities without deadlines are NOT considered expired.
 */
export function isExpired(opp) {
  if (!opp || typeof opp !== 'object') return false
  // Rolling deadlines never expire by date
  if (opp.deadline_type === 'rolling') return false
  // No deadline set — assume still active
  if (!opp.deadline) return false
  try {
    const deadlineDate = new Date(opp.deadline)
    if (isNaN(deadlineDate.getTime())) return false
    // Add 1 day grace period (deadline day itself is still valid)
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    return deadlineDate < cutoff
  } catch {
    return false
  }
}

/**
 * Check all compliance rules for a single opportunity.
 *
 * @param {object} opp
 * @param {{ rejectionCounts?: Record<string, number>, allowExpired?: boolean }} [opts] - Optional per-request counts (avoids shared state).
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function enforceOpportunityPolicy(opp, opts = {}) {
  const rejectionCounts = opts.rejectionCounts ?? null
  if (!opp || typeof opp !== 'object') {
    bumpCount('invalid_object', rejectionCounts)
    return { ok: false, reason: 'invalid_object' }
  }

  if (!pickRealUrl(opp)) {
    bumpCount('no_real_url', rejectionCounts)
    return { ok: false, reason: 'no_real_url' }
  }

  if (isPlaceholderOpportunity(opp)) {
    bumpCount('placeholder_text', rejectionCounts)
    return { ok: false, reason: 'placeholder_text' }
  }

  if (isLoanLike(opp)) {
    bumpCount('loan_like', rejectionCounts)
    return { ok: false, reason: 'loan_like' }
  }

  if (isMatchingFunds(opp)) {
    bumpCount('matching_funds', rejectionCounts)
    return { ok: false, reason: 'matching_funds' }
  }

  // v4: Check expiration — reject opportunities past their fixed deadline
  if (!opts.allowExpired && isExpired(opp)) {
    bumpCount('expired_deadline', rejectionCounts)
    return { ok: false, reason: 'expired_deadline' }
  }

  return { ok: true, reason: null }
}

/**
 * Filter an array of opportunities by policy; optionally merge rejection counts into an external object.
 * @param {object[]} opportunities
 * @param {{ rejectionCounts?: Record<string, number> }} [opts]
 * @returns {{ passed: object[], rejectionCounts: Record<string, number> }}
 */
export function filterByPolicy(opportunities, opts = {}) {
  const outCounts = opts.rejectionCounts ?? {}
  const passed = (Array.isArray(opportunities) ? opportunities : []).filter((opp) => {
    const p = enforceOpportunityPolicy(opp, { rejectionCounts: outCounts })
    return p.ok
  })
  return { passed, rejectionCounts: outCounts }
}

// ─── Re-exports for backward compatibility ────────────────────────────────────

export { isValidHttpUrl } from './crawlerOpportunityContract.js'
export { isLoanOrMatchingFund } from './crawlerOpportunityContract.js'
