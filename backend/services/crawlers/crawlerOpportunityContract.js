import { ALLOWED_RECORD_ORIGINS } from '../../utils/recordOrigins.js'

if (!ALLOWED_RECORD_ORIGINS || typeof ALLOWED_RECORD_ORIGINS.has !== 'function') {
  throw new Error('ALLOWED_RECORD_ORIGINS must be a Set with .has() method')
}

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase()
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]'
}

function uniqueStrings(values = []) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const normalized = normalizeString(String(value || ''))
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function ensureArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

export function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    // Master prompt: no placeholders -- reject example.com, example.org, example.gov, placeholder
    const host = (parsed.hostname || '').toLowerCase()
    if (
      host === 'example.com' ||
      host.endsWith('.example.com') ||
      host === 'example.org' ||
      host.endsWith('.example.org') ||
      host === 'example.gov' ||
      host.endsWith('.example.gov') ||
      host === 'placeholder' ||
      host.endsWith('.placeholder')
    )
      return false
    return true
  } catch {
    return false
  }
}

/**
 * Detect loans, microloans, financing, or matching-fund/cost-share opportunities.
 * Checks schema fields (`is_loan`, `requires_match`, `opportunity_type`) and keyword patterns.
 * @param {Object} opportunity
 * @returns {boolean}
 */
export function isLoanOrMatchingFund(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') return false
  if (opportunity.is_loan === true) return true
  if (opportunity.requires_match === true) return true
  const oppType = String(opportunity.opportunity_type || '').toLowerCase()
  if (['loan', 'loan_program', 'microloan'].includes(oppType)) return true
  const text = `${opportunity.title || ''} ${opportunity.description || ''} ${opportunity.eligibility || ''}`.toLowerCase()
  const loanKeywords = ['\\bloan\\b', '\\bmicroloan\\b', '\\bfinancing\\b']
  // '\\bapr\\b' removed: 'APR' as a word is ambiguous with 'April' in deadline strings;
  // loan detection via is_loan flag and explicit type field is the reliable path.
  const matchKeywords = ['matching funds', 'match required', 'cost share', '1:1 match', 'dollar for dollar']
  if (loanKeywords.some((kw) => new RegExp(kw).test(text))) return true
  if (matchKeywords.some((kw) => text.includes(kw))) return true
  return false
}

function inferEligibilityBullets(raw) {
  if (Array.isArray(raw?.eligibility_bullets)) return raw.eligibility_bullets
  if (typeof raw?.eligibility === 'string' && raw.eligibility.trim().length > 0) {
    return raw.eligibility
      .split(/[\n;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 8)
  }
  return []
}

function inferOpportunityType({ rawOpportunity, crawlerType, sourceFallback }) {
  const explicitType = normalizeLower(rawOpportunity?.opportunity_type || rawOpportunity?.type || '')
  if (explicitType) return explicitType

  const normalizedCrawlerType = normalizeLower(crawlerType || '')
  if (normalizedCrawlerType === 'government_funding') return 'grant'
  if (normalizedCrawlerType === 'student_grants') return 'scholarship'
  if (['local_funding', 'health_resources', 'special_needs', 'ecf_benefits', 'item_matching'].includes(normalizedCrawlerType)) {
    return 'program'
  }
  if (normalizedCrawlerType === 'comprehensive') {
    const sourceHint = normalizeLower(rawOpportunity?.source || sourceFallback || '')
    if (
      sourceHint.includes('government') ||
      sourceHint.includes('grants.gov') ||
      sourceHint.includes('federal') ||
      sourceHint.includes('state')
    ) {
      return 'grant'
    }
    if (sourceHint.includes('student') || sourceHint.includes('scholar')) return 'scholarship'
    return 'program'
  }

  return 'program'
}

export function resolveCrawlerContext(profileOrContext, options = {}) {
  const context =
    profileOrContext &&
    typeof profileOrContext === 'object' &&
    profileOrContext.profile &&
    typeof profileOrContext.profile === 'object'
      ? profileOrContext
      : {
          profile: profileOrContext ?? {},
          sections: profileOrContext?.sections ?? {},
          signals: profileOrContext?.signals ?? null,
          facets: profileOrContext?.facets ?? {},
          trace: profileOrContext?.trace ?? {},
          queryPlan: options?.query_plan ?? null,
        }

  return {
    context,
    profile: context.profile ?? {},
    sections: context.sections ?? {},
    signals: context.signals ?? context.profile?.signals ?? null,
    facets: context.facets ?? {},
    trace: context.trace ?? {},
    queryPlan: context.queryPlan ?? options?.query_plan ?? null,
  }
}

export function mergePlanKeywords(baseKeywords = [], queryPlan = null) {
  const fromPlan = [
    ...(Array.isArray(queryPlan?.mustTerms) ? queryPlan.mustTerms : []),
    ...(Array.isArray(queryPlan?.shouldTerms) ? queryPlan.shouldTerms : []),
  ]
  return uniqueStrings([...baseKeywords, ...fromPlan])
}

export function violatesMustNot(rawOpportunity, queryPlan = null) {
  if (!rawOpportunity || typeof rawOpportunity !== 'object') return false
  const mustNot = Array.isArray(queryPlan?.mustNotTerms) ? queryPlan.mustNotTerms : []
  if (mustNot.length === 0) return false
  const text = normalizeLower(
    `${rawOpportunity.title || ''} ${rawOpportunity.description || ''} ${
      Array.isArray(rawOpportunity.keywords) ? rawOpportunity.keywords.join(' ') : ''
    } ${Array.isArray(rawOpportunity.categories) ? rawOpportunity.categories.join(' ') : ''}`,
  )
  return mustNot.some((term) => {
    const needle = normalizeLower(term)
    return needle && text.includes(needle)
  })
}

export function enforceCrawlerOpportunityContract(
  rawOpportunity,
  {
    crawlerType,
    facets = {},
    queryPlan = null,
    recordOrigin = null,
    sourceFallback = null,
    includeFacetReasons = true,
  } = {},
) {
  if (!isPlainObject(rawOpportunity)) return null
  if (violatesMustNot(rawOpportunity, queryPlan)) return null
  // Goal 3: hard-reject loans and matching-fund requirements before any further processing
  if (isLoanOrMatchingFund(rawOpportunity)) return null

  const url = rawOpportunity.url || rawOpportunity.application_url || rawOpportunity.source_url || null
  if (!isValidHttpUrl(url)) return null

  // Title is required: must be present as an explicit `title` or `name` field.
  const rawTitle = normalizeString(rawOpportunity.title || rawOpportunity.name || '')
  const title = rawTitle
  if (!title) return null

  const description = normalizeString(rawOpportunity.description || rawOpportunity.summary || title)
  const keywords = uniqueStrings(ensureArray(rawOpportunity.keywords))
  const categories = uniqueStrings(ensureArray(rawOpportunity.categories))
  const eligibilityBullets = uniqueStrings(inferEligibilityBullets(rawOpportunity))

  const facetReasons = includeFacetReasons
    ? uniqueStrings([
        facets?.profile?.primary_profile_type
          ? `Profile type: ${String(facets.profile.primary_profile_type).replace(/_/g, ' ')}`
          : '',
        facets?.geo?.state ? `State context: ${String(facets.geo.state).toUpperCase()}` : '',
        facets?.intent?.primary_need_category && facets.intent.primary_need_category !== 'unknown'
          ? `Intent category: ${String(facets.intent.primary_need_category).replace(/_/g, ' ')}`
          : '',
      ])
    : []

  const matchReasons = uniqueStrings([
    ...(Array.isArray(rawOpportunity.match_reasons) ? rawOpportunity.match_reasons : []),
    ...facetReasons,
  ])
  const opportunityType = inferOpportunityType({ rawOpportunity, crawlerType, sourceFallback })

  // Strip audit/decision fields that must only be set by computeMatchDecision()
  const DECISION_ENGINE_FIELDS = [
    'match_decision', 'match_explanation', 'eligibility_status',
    'ineligibility_reasons', 'matcher_version', 'evaluated_at',
    'match_confidence', 'fingerprint', 'profile_fingerprint',
    'opportunity_fingerprint', 'matched_needs',
  ]
  const safeRaw = Object.fromEntries(
    Object.entries(rawOpportunity).filter(([k]) => !DECISION_ENGINE_FIELDS.includes(k))
  )

  const normalized = {
    ...safeRaw,
    title,
    sponsor: rawOpportunity.sponsor ?? rawOpportunity.funder ?? sourceFallback ?? null,
    description: description || null,
    source: rawOpportunity.source ?? sourceFallback ?? crawlerType,
    source_url: rawOpportunity.source_url ?? url,
    application_url: isValidHttpUrl(rawOpportunity.application_url) ? rawOpportunity.application_url : url,
    url,
    categories,
    keywords,
    eligibility_bullets: eligibilityBullets,
    opportunity_type: opportunityType,
    record_origin: normalizeRecordOrigin(
      rawOpportunity.record_origin ?? recordOrigin ?? (opportunityType === 'program' ? 'directory_resource' : 'live_crawl')
    ),
    crawler_type: crawlerType,
    match_reasons: matchReasons,
  }

  return normalized
}

// ALLOWED_RECORD_ORIGINS imported from ../../utils/recordOrigins.js

export function normalizeRecordOrigin(value) {
  if (typeof value === 'string' && ALLOWED_RECORD_ORIGINS && typeof ALLOWED_RECORD_ORIGINS.has === 'function' && ALLOWED_RECORD_ORIGINS.has(value)) return value
  if (typeof value === 'string' && value.startsWith('directory:')) return 'directory_resource'
  return 'live_crawl'
}

export default {
  isValidHttpUrl,
  isLoanOrMatchingFund,
  resolveCrawlerContext,
  mergePlanKeywords,
  violatesMustNot,
  enforceCrawlerOpportunityContract,
  normalizeRecordOrigin,
}
