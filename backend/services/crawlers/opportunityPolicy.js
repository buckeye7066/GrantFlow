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

function bumpCount(reason) {
  _rejectionCounts[reason] = (_rejectionCounts[reason] ?? 0) + 1
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

/** Word-boundary regex patterns that indicate a loan opportunity. */
const LOAN_KEYWORD_RX = [
  /\bloan\b/,
  /\bmicroloan\b/,
  /\bfinancing\b/,
  /\b(?:apr|annual percentage rate)\b/,
  /\brepayment\b/,
  /\brepay\b/,
  /\bcredit line\b/,
  /\brevolving credit\b/,
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
 * Checks schema fields AND keyword heuristics.
 */
export function isLoanLike(opp) {
  if (!opp || typeof opp !== 'object') return false
  if (opp.is_loan === true) return true
  const oppType = String(opp.opportunity_type || '').toLowerCase().trim()
  if (LOAN_OPP_TYPES.has(oppType)) return true
  const text =
    `${opp.title || ''} ${opp.description || ''} ${opp.eligibility || ''} ${opp.eligibility_criteria || ''}`.toLowerCase()
  return LOAN_KEYWORD_RX.some((rx) => rx.test(text))
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
  /\bcoming soon\b/i,
  /\bplaceholder\b/i,
  /\btbd\b/i,
  /\btest opportunity\b/i,
  /\bsample opportunity\b/i,
  /\bfoo bar\b/i,
  /^test$/i,
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

/**
 * Check all compliance rules for a single opportunity.
 *
 * @param {object} opp
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function enforceOpportunityPolicy(opp) {
  if (!opp || typeof opp !== 'object') {
    bumpCount('invalid_object')
    return { ok: false, reason: 'invalid_object' }
  }

  // 1. Real URL required
  if (!pickRealUrl(opp)) {
    bumpCount('no_real_url')
    return { ok: false, reason: 'no_real_url' }
  }

  // 2. Not placeholder content
  if (isPlaceholderOpportunity(opp)) {
    bumpCount('placeholder_text')
    return { ok: false, reason: 'placeholder_text' }
  }

  // 3. Not a loan
  if (isLoanLike(opp)) {
    bumpCount('loan_like')
    return { ok: false, reason: 'loan_like' }
  }

  // 4. Not matching-funds
  if (isMatchingFunds(opp)) {
    bumpCount('matching_funds')
    return { ok: false, reason: 'matching_funds' }
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
  resetPolicyRejectionCounts()
  const passed = (Array.isArray(opportunities) ? opportunities : []).filter((opp) => {
    const p = enforceOpportunityPolicy(opp)
    return p.ok
  })
  const counts = getPolicyRejectionCounts()
  Object.entries(counts).forEach(([k, v]) => {
    if (v > 0) outCounts[k] = (outCounts[k] ?? 0) + v
  })
  return { passed, rejectionCounts: outCounts }
}

// ─── Re-exports for backward compatibility ────────────────────────────────────

export { isValidHttpUrl } from './crawlerOpportunityContract.js'
export { isLoanOrMatchingFund } from './crawlerOpportunityContract.js'
