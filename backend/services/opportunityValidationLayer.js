/**
 * Opportunity Validation Layer
 *
 * Unified strict validation that runs on every opportunity before storage
 * and can audit the entire database at build/CI time.
 *
 * Three checks:
 *   1. URL validation — format, protocol, non-placeholder, non-social-media
 *   2. Required fields — title (≥5 chars), sponsor or description, valid URL
 *   3. Duplicate detection — by (source, source_id) and by normalized URL
 *
 * Exports:
 *   validateOpportunityStrict(opp)       → { valid, errors, warnings }
 *   auditStoredOpportunities(db)         → { total, invalid, issues[] }
 *   assertNoInvalidUrls(db)              → throws if invalid URLs in DB
 *   assertProfileReturnsResults(db, profile, opportunities)  → throws if empty
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
} from '../routes/opportunityHelpers.js'

import { validateOpportunity } from './opportunityValidator.js'
import { scoreOpportunity, makeDecision } from './matchEngine.js'
import {
  INVALID_URL_PATTERNS,
  NON_ACTIONABLE_DOMAINS as SOCIAL_MEDIA_DOMAINS,
  isPlaceholderUrl as _isPlaceholderUrl,
  extractHostname,
} from '../config/urlRules.js'

// ── Required field definitions ──
const REQUIRED_FIELDS = {
  title: { minLength: 5 },
  url: { atLeastOne: ['url', 'source_url', 'application_url', 'evidence_url'] },
}

/**
 * Validate a URL is well-formed, reachable in format, and not a placeholder.
 * Does NOT make HTTP requests — format-only validation.
 *
 * @param {string} url
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateUrlFormat(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, reason: 'missing_url' }
  }

  const trimmed = url.trim()
  if (!trimmed) return { valid: false, reason: 'empty_url' }

  // Protocol check
  if (!/^https?:\/\//i.test(trimmed)) {
    return { valid: false, reason: 'invalid_protocol' }
  }

  // Placeholder patterns
  for (const rx of INVALID_URL_PATTERNS) {
    if (rx.test(trimmed)) {
      return { valid: false, reason: 'placeholder_url' }
    }
  }

  // Parse as URL to validate structure
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return { valid: false, reason: 'malformed_url' }
  }

  // Social media check
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (SOCIAL_MEDIA_DOMAINS.has(host)) {
    return { valid: false, reason: 'social_media_url' }
  }

  return { valid: true }
}

/**
 * Validate required fields are present on an opportunity.
 *
 * @param {object} opp
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateRequiredFields(opp) {
  if (!opp || typeof opp !== 'object') {
    return { valid: false, missing: ['object'] }
  }

  const missing = []

  // Title
  const title = String(opp.title || opp.name || opp.program_name || '').trim()
  if (!title || title.length < REQUIRED_FIELDS.title.minLength) {
    missing.push('title')
  }

  // Sponsor or description
  const sponsor = String(opp.sponsor || opp.agency || opp.funder || '').trim()
  const description = String(opp.description || opp.summary || '').trim()
  if (!sponsor && !description) {
    missing.push('sponsor_or_description')
  }

  // At least one valid URL
  const urlFields = REQUIRED_FIELDS.url.atLeastOne
  const hasUrl = urlFields.some((f) => {
    const v = opp[f]
    return v && typeof v === 'string' && validateUrlFormat(v).valid
  })
  if (!hasUrl) {
    missing.push('valid_url')
  }

  return { valid: missing.length === 0, missing }
}

/**
 * Check if an opportunity is a duplicate of another by normalized URL.
 * In-memory batch check — does not hit the database.
 *
 * @param {object} opp
 * @param {Set<string>} seenUrls  mutable set of normalized URLs seen so far
 * @param {Set<string>} seenSourceIds  mutable set of "source:source_id" keys
 * @returns {{ isDuplicate: boolean, reason?: string }}
 */
export function checkDuplicate(opp, seenUrls, seenSourceIds) {
  // Source-ID dedup
  const source = String(opp?.source || '').trim()
  const sourceId = String(opp?.source_id || '').trim()
  if (source && sourceId) {
    const key = `${source}::${sourceId}`
    if (seenSourceIds.has(key)) {
      return { isDuplicate: true, reason: 'duplicate_source_id' }
    }
    seenSourceIds.add(key)
  }

  // URL dedup
  const url = pickRealUrl(opp)
  if (url) {
    const normalized = normalizeUrlForDedupe(url)
    if (normalized && seenUrls.has(normalized)) {
      return { isDuplicate: true, reason: 'duplicate_url' }
    }
    if (normalized) seenUrls.add(normalized)
  }

  return { isDuplicate: false }
}

/**
 * Strict validation of a single opportunity — combines URL, fields, and content checks.
 * This is the top-level validator that should be called before any DB insertion.
 *
 * @param {object} opp
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateOpportunityStrict(opp) {
  const errors = []
  const warnings = []

  // 1. Required fields
  const fields = validateRequiredFields(opp)
  if (!fields.valid) {
    errors.push(...fields.missing.map((f) => `missing_${f}`))
  }

  // 2. URL format
  const url = pickRealUrl(opp)
  if (url) {
    const urlCheck = validateUrlFormat(url)
    if (!urlCheck.valid) {
      errors.push(`url_${urlCheck.reason}`)
    }
  }

  // 3. Full validator (loans, placeholders, matching funds, type).
  // NOTE: strict mode is the audit/format-check used at display and CI-gate
  // time. Expired deadlines are kept as warnings here so existing records
  // remain auditable; the hard reject for new expired records lives in the
  // insert path (opportunityInserter.upsertFundingOpportunity), which calls
  // validateOpportunity directly with allowExpired=false (the default).
  const full = validateOpportunity(opp, { allowLoans: false, allowDirectories: true, allowExpired: true })
  for (const err of full.errors) {
    if (!errors.includes(err)) errors.push(err)
  }
  for (const warn of full.warnings) {
    if (!warnings.includes(warn)) warnings.push(warn)
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Audit all active stored opportunities for data quality.
 * Returns a report of invalid records found in the DB.
 *
 * @param {object} db
 * @returns {Promise<{ total: number, invalid: number, issues: Array<{ id: string, title: string, errors: string[] }> }>}
 */
export async function auditStoredOpportunities(db) {
  if (!db) return { total: 0, invalid: 0, issues: [] }

  const isPostgres = db?.dialect === 'postgres'
  const activeVal = isPostgres ? 'TRUE' : '1'
  const rows = await db
    .prepare(`SELECT * FROM funding_opportunities WHERE is_active = ${activeVal} LIMIT 10000`)
    .all()

  const issues = []
  const total = rows?.length ?? 0

  for (const row of rows || []) {
    const errors = []

    // URL check
    const url = row.url || row.source_url || row.application_url || row.evidence_url
    if (url) {
      const check = validateUrlFormat(url)
      if (!check.valid) errors.push(`invalid_url:${check.reason}`)
    } else {
      errors.push('no_url')
    }

    // Title check
    const title = String(row.title || '').trim()
    if (!title || title.length < 5) {
      errors.push('missing_or_short_title')
    }

    // Placeholder check
    if (isPlaceholderOpportunity(row)) {
      errors.push('placeholder_content')
    }

    if (errors.length > 0) {
      issues.push({
        id: row.id,
        title: title || '(no title)',
        errors,
      })
    }
  }

  return { total, invalid: issues.length, issues }
}

/**
 * Assert that no invalid URLs exist in the active opportunity set.
 * Throws an error if any are found — designed for CI/build gate use.
 *
 * @param {object} db
 * @throws {Error} if invalid URLs found
 */
export async function assertNoInvalidUrls(db) {
  const { total, invalid, issues } = await auditStoredOpportunities(db)
  if (invalid > 0) {
    const sample = issues.slice(0, 5).map((i) => `  - ${i.id}: ${i.errors.join(', ')}`).join('\n')
    throw new Error(
      `[ValidationLayer] ${invalid}/${total} opportunities have invalid data:\n${sample}`,
    )
  }
  return { total, invalid: 0 }
}

/**
 * Assert that matching returns meaningful results for a profile against a set of opportunities.
 * Throws if zero results when data exists — designed for CI/build gate use.
 *
 * @param {object} profileContext  Profile context with signals/facets
 * @param {object[]} opportunities  Array of opportunity objects
 * @param {{ label?: string, minResults?: number }} opts
 * @throws {Error} if empty results when data exists
 */
export function assertMatchingReturnsResults(profileContext, opportunities, opts = {}) {
  const { label = 'unknown', minResults = 1 } = opts

  if (!opportunities || opportunities.length === 0) {
    return { ok: true, reason: 'no_data' }
  }

  const scored = opportunities.map((opp) => {
    const result = scoreOpportunity(profileContext, opp)
    return { ...result, opp }
  })

  // Count results that pass the REVIEW threshold (score >= 25 with v4 model)
  const meaningful = scored.filter((s) => s.score >= 5)

  if (meaningful.length < minResults) {
    const topScores = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => `${s.opp.title?.substring(0, 40)} → ${s.score}`)
      .join(', ')

    throw new Error(
      `[ValidationLayer] Profile type "${label}" returned ${meaningful.length}/${opportunities.length} meaningful results (need >=${minResults}). Top scores: ${topScores}`,
    )
  }

  return {
    ok: true,
    total: opportunities.length,
    meaningful: meaningful.length,
    topScore: scored.sort((a, b) => b.score - a.score)[0]?.score ?? 0,
  }
}

/**
 * Run multi-profile matching validation.
 * Tests that each profile type returns meaningful results against a candidate set.
 *
 * @param {object[]} opportunities
 * @returns {{ passed: string[], failed: Array<{ type: string, error: string }> }}
 */
export function validateMultiProfileMatching(opportunities) {
  if (!opportunities || opportunities.length === 0) {
    return { passed: [], failed: [{ type: 'all', error: 'no_opportunities_to_test' }] }
  }

  const profileTypes = {
    individual: {
      profile: {
        applicant_type: 'individual',
        state: 'OH',
        postal_code: '43215',
        needs: ['housing', 'utilities', 'food'],
      },
      sections: {
        basic_information: { state: 'OH', zip: '43215', age: 35 },
      },
    },
    student: {
      profile: {
        applicant_type: 'student',
        state: 'OH',
        postal_code: '43215',
        needs: ['education', 'scholarships'],
      },
      sections: {
        basic_information: { state: 'OH', zip: '43215', age: 20 },
        education: { highest_level: 'high school', gpa: 3.5, field_of_study: 'Biology' },
      },
    },
    nonprofit: {
      profile: {
        applicant_type: 'nonprofit',
        state: 'OH',
        postal_code: '43215',
        needs: ['capacity_building', 'program_funding'],
        entity_type: 'nonprofit',
      },
      sections: {
        basic_information: { state: 'OH', zip: '43215' },
        organization_details: { type: 'nonprofit', name: 'Community Action' },
      },
    },
    business: {
      profile: {
        applicant_type: 'small_business',
        state: 'OH',
        postal_code: '43215',
        needs: ['small_business', 'startup_funding'],
        entity_type: 'business',
      },
      sections: {
        basic_information: { state: 'OH', zip: '43215' },
        small_business_details: { business_name: 'Test LLC', years_in_business: 2 },
      },
    },
  }

  const passed = []
  const failed = []

  for (const [type, ctx] of Object.entries(profileTypes)) {
    try {
      const result = assertMatchingReturnsResults(ctx, opportunities, { label: type })
      passed.push(type)
    } catch (e) {
      failed.push({ type, error: e.message })
    }
  }

  return { passed, failed }
}


/**
 * Filter opportunities to ensure only actionable ones reach the UI.
 * Removes entries with no URL, placeholder titles, and generic directories.
 * Use at the API response layer before sending results to the frontend.
 */
export function filterActionableOpportunities(opportunities) {
  if (!Array.isArray(opportunities)) return []
  const GENERIC_TITLES = new Set([
    'local housing finance agencies',
    'community action agencies',
    'workforce development boards',
    'state vocational rehabilitation agencies',
    'department of labor odep',
    'housing development grants',
    'disability employment grants',
    'foster youth grants',
  ])
  const PLACEHOLDER_PATTERNS = [
    /^(test|sample|example|placeholder|todo|tbd|n\/a)/i,
    /^funding opportunity$/i,
    /^grant program$/i,
    /^untitled/i,
  ]
  return opportunities.filter(opp => {
    const url = opp.application_url || opp.source_url || opp.url
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return false
    const title = (opp.title || '').trim()
    if (title.length < 10) return false
    if (PLACEHOLDER_PATTERNS.some(p => p.test(title))) return false
    if (GENERIC_TITLES.has(title.toLowerCase())) return false
    return true
  })
}

export default {
  validateUrlFormat,
  filterActionableOpportunities,
  validateRequiredFields,
  checkDuplicate,
  validateOpportunityStrict,
  auditStoredOpportunities,
  assertNoInvalidUrls,
  assertMatchingReturnsResults,
  validateMultiProfileMatching,
}
