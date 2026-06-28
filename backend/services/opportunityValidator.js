import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('services:opportunityValidator')
/**
 * Opportunity Validator
 *
 * Comprehensive validation pipeline for funding opportunities. Every opportunity
 * entering the system MUST pass through validateOpportunity() before DB insertion.
 *
 * Checks enforced:
 *  1. Required fields: title (≥5 chars), at least one of sponsor/description
 *  2. Valid reachable URL (format + non-placeholder)
 *  3. Not a loan unless explicitly allowed
 *  4. Not placeholder/stub content
 *  5. Categorized (opportunity_type must be set)
 *  6. Expiration detection — closed deadlines flagged
 *  7. Generic directory detection — directories without actionable links flagged
 *  8. URL normalization for deduplication
 */

import {
  isValidRealUrl,
  isLoanLike,
  isMatchingFunds,
  isPlaceholderOpportunity,
  pickRealUrl,
} from './shared/opportunityPolicy.js'

import {
  normalizeUrlForDedupe,
  isExpiredOpportunity,
  isDirectoryLike,
  parseLooseDate,
} from '../routes/opportunityHelpers.js'

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const VALID_OPPORTUNITY_TYPES = new Set([
  'grant', 'scholarship', 'aid', 'benefit', 'program', 'fellowship',
  'award', 'assistance', 'subsidy', 'voucher', 'rebate', 'credit',
  'service', 'training', 'in_kind', 'pro_bono', 'directory',
  'emergency', 'forgivable_loan',
])

const GENERIC_DIRECTORY_URL_PATTERNS = [
  /\/search\/?$/i,
  /\/results\/?$/i,
  /\/directory\/?$/i,
  /\/finder\/?$/i,
  /\/lookup\/?$/i,
  /\/browse\/?$/i,
  /\/listing\/?$/i,
  /google\.com\/search/i,
  /bing\.com\/search/i,
  /yahoo\.com\/search/i,
  /duckduckgo\.com/i,
]

const GENERIC_DIRECTORY_TITLE_PATTERNS = [
  /^search results?\b/i,
  /^find\s+(a\s+)?grant/i,
  /^grant\s+database$/i,
  /^funding\s+directory$/i,
  /^resource\s+list$/i,
  /^list\s+of\s+(grants?|programs?|resources?)/i,
]

// Social media / non-actionable link patterns
const NON_ACTIONABLE_URL_PATTERNS = [
  /^https?:\/\/(www\.)?(facebook|twitter|x|instagram|tiktok|youtube|linkedin|pinterest)\.com/i,
  /^https?:\/\/(www\.)?reddit\.com/i,
  /^https?:\/\/(www\.)?medium\.com/i,
  /^https?:\/\/(www\.)?wikipedia\.org/i,
]

// ─── VALIDATION RESULT TYPE ──────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether the opportunity passes all required checks
 * @property {string[]} errors - Hard failures (opportunity must be rejected)
 * @property {string[]} warnings - Soft issues (opportunity accepted but flagged)
 * @property {string|null} normalizedUrl - Normalized URL for deduplication
 * @property {string} opportunityType - Resolved opportunity type
 * @property {boolean} isExpired - Whether the deadline has passed
 * @property {boolean} isDirectory - Whether this is a directory-style entry
 */

// ─── CORE VALIDATION ─────────────────────────────────────────────────────────

/**
 * Validate a single opportunity against all quality standards.
 *
 * @param {Object} opp - Raw opportunity object
 * @param {Object} [opts]
 * @param {boolean} [opts.allowLoans=false] - If true, loans are accepted with a warning
 * @param {boolean} [opts.allowDirectories=true] - If true, directories with actionable URLs pass
 * @param {boolean} [opts.requireDescription=false] - If true, description is required (not just sponsor)
 * @param {boolean} [opts.allowExpired=false] - If true, expired deadlines downgrade to warning instead of error
 * @returns {ValidationResult}
 */
export function validateOpportunity(opp, opts = {}) {
  const { allowLoans = false, allowDirectories = true, requireDescription = false, allowExpired = false } = opts
  const errors = []
  const warnings = []

  if (!opp || typeof opp !== 'object') {
    return { valid: false, errors: ['invalid_object'], warnings: [], normalizedUrl: null, opportunityType: 'unknown', isExpired: false, isDirectory: false }
  }

  // ── 1. Required fields ──
  const title = String(opp.title || opp.name || '').trim()
  if (!title || title.length < 5) {
    errors.push('missing_or_short_title')
  }

  const sponsor = String(opp.sponsor || opp.agency || opp.organization || '').trim()
  const description = String(opp.description || opp.summary || '').trim()

  if (!sponsor && !description) {
    errors.push('missing_sponsor_and_description')
  } else if (requireDescription && !description) {
    errors.push('missing_description')
  } else if (!sponsor && description.length < 20) {
    warnings.push('no_sponsor_short_description')
  }

  // ── 2. URL validation ──
  const realUrl = pickRealUrl(opp)
  if (!realUrl) {
    errors.push('no_valid_url')
  } else {
    // Check for non-actionable URLs (social media, search engines)
    if (NON_ACTIONABLE_URL_PATTERNS.some((rx) => rx.test(realUrl))) {
      errors.push('non_actionable_url')
    }
  }

  // ── 3. Placeholder content ──
  if (isPlaceholderOpportunity(opp)) {
    errors.push('placeholder_content')
  }

  // ── 4. Loan check ──
  if (isLoanLike(opp)) {
    if (allowLoans) {
      warnings.push('loan_opportunity_allowed')
    } else {
      errors.push('loan_like')
    }
  }

  // ── 5. Matching funds ──
  if (isMatchingFunds(opp)) {
    errors.push('matching_funds')
  }

  // ── 6. Opportunity type categorization ──
  let opportunityType = String(opp.opportunity_type || opp.type || '').trim().toLowerCase()
  if (!opportunityType || !VALID_OPPORTUNITY_TYPES.has(opportunityType)) {
    opportunityType = inferOpportunityType(opp)
    if (opportunityType !== 'grant') {
      warnings.push(`inferred_type:${opportunityType}`)
    }
  }

  // ── 7. Expiration detection ──
  // Expired opportunities are rejected by default. Callers handling legacy
  // catalog backfills (which need to keep historical records labeled) can
  // pass `allowExpired: true` to downgrade to a warning instead.
  const isExpired = isExpiredOpportunity(opp)
  if (isExpired) {
    if (allowExpired) {
      warnings.push('deadline_passed')
    } else {
      errors.push('deadline_passed')
    }
  }

  // ── 8. Generic directory detection ──
  const isDirectory = isDirectoryLike(opp) || isGenericDirectory(opp)
  if (isDirectory) {
    if (!allowDirectories) {
      errors.push('generic_directory')
    } else if (!hasActionableDirectoryLink(opp)) {
      errors.push('directory_no_actionable_link')
    } else {
      warnings.push('directory_with_actionable_link')
    }
  }

  // ── 9. URL normalization for dedup ──
  const normalizedUrl = realUrl ? normalizeUrlForDedupe(realUrl) : null

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalizedUrl,
    opportunityType,
    isExpired,
    isDirectory,
  }
}

// ─── TYPE INFERENCE ──────────────────────────────────────────────────────────

function inferOpportunityType(opp) {
  const text = `${opp.title || ''} ${opp.description || ''}`.toLowerCase()

  if (/\bscholarship\b/.test(text)) return 'scholarship'
  if (/\bfellowship\b/.test(text)) return 'fellowship'
  if (/\baward\b/.test(text)) return 'award'
  if (/\bsubsid(y|ies)\b/.test(text)) return 'subsidy'
  if (/\bvoucher\b/.test(text)) return 'voucher'
  if (/\brebate\b/.test(text)) return 'rebate'
  if (/\bpro\s*bono\b/.test(text)) return 'pro_bono'
  if (/\bin[- ]kind\b/.test(text)) return 'in_kind'
  if (/\b(training|workshop|certification)\b/.test(text)) return 'training'
  if (/\b(benefit|assistance|aid)\b/.test(text)) return 'assistance'
  if (/\b(program|service)\b/.test(text)) return 'program'
  return 'grant'
}

// ─── DIRECTORY DETECTION ──────────────────────────────────────────────────────

function isGenericDirectory(opp) {
  const url = pickRealUrl(opp)
  if (url && GENERIC_DIRECTORY_URL_PATTERNS.some((rx) => rx.test(url))) {
    return true
  }
  const title = String(opp.title || '').trim()
  if (title && GENERIC_DIRECTORY_TITLE_PATTERNS.some((rx) => rx.test(title))) {
    return true
  }
  return false
}

function hasActionableDirectoryLink(opp) {
  const url = pickRealUrl(opp)
  if (!url) return false
  // Search engine results are never actionable
  if (/google\.com\/search|bing\.com\/search|yahoo\.com\/search|duckduckgo\.com/i.test(url)) {
    return false
  }
  // .gov, .edu, .org directories are actionable
  if (/\.(gov|edu|org)\b/i.test(url)) return true
  // Known assistance directories are actionable
  if (/findhelp\.org|211\.org|benefitscheckup\.org|needhelppayingbills\.com/i.test(url)) return true
  return true
}

// ─── URL DEDUP CHECK ──────────────────────────────────────────────────────────

/**
 * Check if an opportunity with the same normalized URL already exists in the DB.
 *
 * @param {Object} db - Database connection
 * @param {string} normalizedUrl - From validateOpportunity().normalizedUrl
 * @param {string} [excludeId] - ID to exclude (for updates)
 * @returns {Promise<{isDuplicate: boolean, existingId: string|null}>}
 */
export async function checkUrlDuplicate(db, normalizedUrl, excludeId = null) {
  if (!normalizedUrl || !db) return { isDuplicate: false, existingId: null }

  try {
    const row = await db.prepare(`
      SELECT id, source_url, application_url
      FROM funding_opportunities
      WHERE is_active = 1
      LIMIT 500
    `).all()

    for (const r of (Array.isArray(row) ? row : [])) {
      if (excludeId && r.id === excludeId) continue
      const existingNorm =
        normalizeUrlForDedupe(r.application_url) ||
        normalizeUrlForDedupe(r.source_url)
      if (existingNorm && existingNorm === normalizedUrl) {
        return { isDuplicate: true, existingId: r.id }
      }
    }
  } catch (err) {
    // URL dedup is best-effort; we don't block insertion on query failures,
    // but a silent catch hides real DB issues. Log loudly so operators see it.
    qualityLog.error('[opportunityValidator] checkUrlDuplicate query failed:', err?.message || err)
  }

  return { isDuplicate: false, existingId: null }
}

/**
 * Batch URL dedup: given an array of opportunities, remove those whose normalized
 * URL matches another opportunity already in the set (keeps first occurrence).
 *
 * @param {Object[]} opportunities
 * @returns {{ unique: Object[], duplicateCount: number }}
 */
export function deduplicateByUrl(opportunities) {
  if (!Array.isArray(opportunities)) return { unique: [], duplicateCount: 0 }
  const seen = new Set()
  const unique = []
  let duplicateCount = 0

  for (const opp of opportunities) {
    const url = pickRealUrl(opp)
    const normalized = url ? normalizeUrlForDedupe(url) : null
    if (normalized && seen.has(normalized)) {
      duplicateCount++
      continue
    }
    if (normalized) seen.add(normalized)
    unique.push(opp)
  }

  return { unique, duplicateCount }
}

// ─── BATCH VALIDATION ────────────────────────────────────────────────────────

/**
 * Validate and filter an array of opportunities. Returns only valid ones.
 *
 * @param {Object[]} opportunities
 * @param {Object} [opts] - Passed to validateOpportunity
 * @returns {{ valid: Object[], rejected: Array<{opportunity: Object, errors: string[]}>, stats: Object }}
 */
export function validateBatch(opportunities, opts = {}) {
  if (!Array.isArray(opportunities)) return { valid: [], rejected: [], stats: { total: 0, valid: 0, rejected: 0, expired: 0, directories: 0, duplicates: 0 } }

  // Dedup by URL first
  const { unique, duplicateCount } = deduplicateByUrl(opportunities)

  const valid = []
  const rejected = []
  let expiredCount = 0
  let directoryCount = 0

  for (const opp of unique) {
    const result = validateOpportunity(opp, opts)
    if (result.valid) {
      opp._validationMeta = {
        normalizedUrl: result.normalizedUrl,
        opportunityType: result.opportunityType,
        isExpired: result.isExpired,
        isDirectory: result.isDirectory,
        warnings: result.warnings,
      }
      if (result.isExpired) expiredCount++
      if (result.isDirectory) directoryCount++
      valid.push(opp)
    } else {
      rejected.push({ opportunity: opp, errors: result.errors })
    }
  }

  return {
    valid,
    rejected,
    stats: {
      total: opportunities.length,
      valid: valid.length,
      rejected: rejected.length,
      expired: expiredCount,
      directories: directoryCount,
      duplicates: duplicateCount,
    },
  }
}
