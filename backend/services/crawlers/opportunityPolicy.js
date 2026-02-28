/**
 * Central non-negotiable policy for funding opportunities.
 * Applied to: live crawler normalization, after rescoring, DB fallback formatting, and before persistence.
 * Rejection reasons are counted so debug output explains "why 0".
 */

const LOAN_TYPES = new Set(['loan', 'loan_program', 'microloan', 'credit_line'])
const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'placeholder', 'localhost', '127.0.0.1']
const PLACEHOLDER_PATTERNS = [
  /lorem\s+ipsum/i,
  /coming\s+soon/i,
  /tbd\b/i,
  /\btba\b/i,
  /placeholder/i,
  /dummy\s+(data|url)/i,
  /sample\s+(data|url)/i,
]
const LOAN_KEYWORDS = [
  'loan', 'microloan', 'financing', 'apr', 'repay', 'repayment', 'borrow', 'borrower',
  'interest rate', 'principal', 'stafford', 'plus loan', 'private loan', 'student loan',
  'credit line', 'line of credit',
]
const MATCHING_FUND_KEYWORDS = [
  'matching funds', 'match required', 'cost share', 'cost-share', '1:1 match',
  'dollar-for-dollar', 'dollar for dollar', 'match percentage', 'leveraged funding',
  'requires match', 'must match', 'matching requirement', 'match funds',
]

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

/**
 * Strict http/https only; rejects placeholder hosts.
 * @param {string} url
 * @returns {boolean}
 */
export function isValidRealUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = (parsed.hostname || '').toLowerCase()
    if (PLACEHOLDER_HOSTS.some((h) => host.includes(h))) return false
    return true
  } catch {
    return false
  }
}

/**
 * Detect placeholder / dummy / example opportunities.
 * @param {Object} opp
 * @returns {boolean} true if opp looks like a placeholder
 */
export function isPlaceholderOpportunity(opp) {
  if (!opp || typeof opp !== 'object') return true
  const url = opp.url ?? opp.application_url ?? opp.source_url ?? ''
  if (typeof url === 'string' && url.trim()) {
    try {
      const parsed = new URL(url.trim())
      const host = (parsed.hostname || '').toLowerCase()
      if (PLACEHOLDER_HOSTS.some((h) => host.includes(h))) return true
    } catch {
      // invalid URL
    }
  }
  const title = normalizeString(opp.title ?? opp.name ?? '')
  const desc = normalizeString(opp.description ?? opp.summary ?? '')
  const combined = `${title} ${desc}`
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(combined))) return true
  if (!title && !desc) return true
  return false
}

/**
 * Detect loan-like opportunities (type + keywords).
 * @param {Object} opp
 * @returns {boolean}
 */
export function isLoanLike(opp) {
  if (!opp || typeof opp !== 'object') return false
  const type = normalizeString(opp.opportunity_type ?? opp.type ?? opp.grant_type ?? '')
  if (LOAN_TYPES.has(type)) return true
  const text = `${opp.title ?? ''} ${opp.description ?? ''} ${(opp.keywords || []).join(' ')} ${(opp.categories || []).join(' ')} ${opp.eligibility ?? ''}`.toLowerCase()
  return LOAN_KEYWORDS.some((kw) => text.includes(kw))
}

/**
 * Detect matching-funds / match-required opportunities.
 * @param {Object} opp
 * @returns {boolean}
 */
export function isMatchingFunds(opp) {
  if (!opp || typeof opp !== 'object') return false
  if (opp.requires_match === true || opp.requires_match === 1) return true
  if (typeof opp.match_percentage === 'number' && opp.match_percentage > 0) return true
  if (typeof opp.match_percentage === 'string' && parseFloat(opp.match_percentage) > 0) return true
  const text = `${opp.title ?? ''} ${opp.description ?? ''} ${(opp.keywords || []).join(' ')} ${(opp.eligibility ?? '')}`.toLowerCase()
  return MATCHING_FUND_KEYWORDS.some((kw) => text.includes(kw))
}

/**
 * Enforce full policy. Returns { ok, reason, oppNormalizedMaybe }.
 * oppNormalizedMaybe: if ok, the same opp (or a shallow copy with normalized url); otherwise undefined.
 * @param {Object} opp
 * @param {{ rejectionCounts?: Record<string, number> }} options - optional counter object to bump rejection reason
 * @returns {{ ok: boolean, reason?: string, oppNormalizedMaybe?: Object }}
 */
export function enforceOpportunityPolicy(opp, options = {}) {
  const rejectionCounts = options.rejectionCounts ?? null

  if (!opp || typeof opp !== 'object') {
    if (rejectionCounts) rejectionCounts.invalid_object = (rejectionCounts.invalid_object ?? 0) + 1
    return { ok: false, reason: 'invalid_object' }
  }

  const url = opp.url ?? opp.application_url ?? opp.source_url ?? null
  if (!url || typeof url !== 'string' || !url.trim()) {
    if (rejectionCounts) rejectionCounts.missing_url = (rejectionCounts.missing_url ?? 0) + 1
    return { ok: false, reason: 'missing_url' }
  }
  if (!isValidRealUrl(url)) {
    if (rejectionCounts) rejectionCounts.invalid_url = (rejectionCounts.invalid_url ?? 0) + 1
    return { ok: false, reason: 'invalid_url' }
  }

  if (isPlaceholderOpportunity(opp)) {
    if (rejectionCounts) rejectionCounts.placeholder = (rejectionCounts.placeholder ?? 0) + 1
    return { ok: false, reason: 'placeholder' }
  }

  if (isLoanLike(opp)) {
    if (rejectionCounts) rejectionCounts.loan_like = (rejectionCounts.loan_like ?? 0) + 1
    return { ok: false, reason: 'loan_like' }
  }

  if (isMatchingFunds(opp)) {
    if (rejectionCounts) rejectionCounts.matching_funds = (rejectionCounts.matching_funds ?? 0) + 1
    return { ok: false, reason: 'matching_funds' }
  }

  const title = (opp.title ?? opp.name ?? '').trim()
  if (!title) {
    if (rejectionCounts) rejectionCounts.missing_title = (rejectionCounts.missing_title ?? 0) + 1
    return { ok: false, reason: 'missing_title' }
  }

  return { ok: true, oppNormalizedMaybe: opp }
}

/**
 * Filter an array of opportunities to only policy-compliant ones; optionally accumulate rejection counts.
 * @param {Object[]} opportunities
 * @param {{ rejectionCounts?: Record<string, number> }} options
 * @returns {{ passed: Object[], rejectionCounts: Record<string, number> }}
 */
export function filterByPolicy(opportunities, options = {}) {
  const rejectionCounts = options.rejectionCounts ?? {}
  const passed = []
  for (const opp of Array.isArray(opportunities) ? opportunities : []) {
    const result = enforceOpportunityPolicy(opp, { rejectionCounts })
    if (result.ok && result.oppNormalizedMaybe) passed.push(result.oppNormalizedMaybe)
  }
  return { passed, rejectionCounts }
}

export default {
  isValidRealUrl,
  isPlaceholderOpportunity,
  isLoanLike,
  isMatchingFunds,
  enforceOpportunityPolicy,
  filterByPolicy,
}
