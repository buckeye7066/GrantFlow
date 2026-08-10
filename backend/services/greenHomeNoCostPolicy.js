const POLICY_VERSION = 'green_home_no_cost_v2'
const SOURCE_REVIEWED_AT = '2026-08-10'
const SOURCE_MAX_AGE_DAYS = 60
const LINK_MAX_AGE_DAYS = 60

export const GREEN_HOME_NO_COST_POLICY_VERSION = POLICY_VERSION

// Keep each request concrete and short enough for the existing item-search
// query builder. The strict no-cost policy is applied to returned records; it
// must not be encoded as one long quoted search phrase that starves recall.
export const GREEN_HOME_SEARCH_ITEMS = Object.freeze([
  'home weatherization',
  'heat pump replacement',
  'geothermal home heating',
  'residential solar installation',
  'residential small wind turbine',
])

export const OFFICIAL_GREEN_HOME_PATHS = Object.freeze([
  {
    id: 'doe-weatherization-assistance',
    title: 'Weatherization Assistance Program: find your state or local provider',
    sponsor: 'U.S. Department of Energy',
    description:
      'Official application path for income-qualified weatherization services. A local energy audit determines which measures are installed, such as insulation, air sealing, and eligible heating or cooling improvements.',
    url: 'https://www.energy.gov/cmei/scep/wap/how-apply-weatherization-assistance',
    source_url: 'https://www.energy.gov/cmei/scep/wap/how-apply-weatherization-assistance',
    result_source: 'official_green_home_locator',
    record_origin: 'official_directory',
    source_trust_tier: 'official_portal',
    opportunity_kind: 'directory',
    is_pointer: true,
    is_lead: false,
    no_cost_status: 'official_no_cost_path',
    no_cost_evidence:
      'DOE identifies WAP as free weatherization assistance for qualifying low-income households; the state or local provider determines eligibility and the scope of work.',
    reviewed_at: SOURCE_REVIEWED_AT,
    source_reviewed_at: SOURCE_REVIEWED_AT,
    source_reviewed_by: 'GrantFlow official-source review',
    source_review_version: POLICY_VERSION,
    link_status: 'ok',
    last_verified_at: SOURCE_REVIEWED_AT,
    applicant_types: ['individual', 'family', 'homeowner', 'renter'],
    upgrades: ['energy audit', 'insulation', 'air sealing', 'weatherization', 'eligible heating and cooling work'],
    eligibility_bullets: [
      'Income eligibility is determined by the state, territory, Tribe, or local provider.',
      'DOE guidance generally recognizes households at or below 200% of the federal poverty guidelines, SSI recipients, or the state-selected LIHEAP standard.',
      'Homeowners and renters may apply; renters normally require landlord permission before work begins.',
      'The provider and energy audit determine which upgrades are available. Wind, solar, geothermal, or heat-pump work is not guaranteed.',
    ],
  },
  {
    id: 'hhs-liheap-weatherization-repairs',
    title: 'LIHEAP weatherization and energy-related home repair assistance',
    sponsor: 'U.S. Department of Health and Human Services',
    description:
      'Official federal benefit locator administered by states, territories, and Tribes. Depending on the local program, LIHEAP may weatherize a home or provide minor energy-related repairs, including eligible heating or cooling equipment work.',
    url: 'https://www.acf.hhs.gov/ocs/programs/liheap',
    source_url: 'https://ocsannualreport.acf.hhs.gov/annual-report-fy24/liheap-fact-sheet',
    result_source: 'official_green_home_locator',
    record_origin: 'official_directory',
    source_trust_tier: 'official_portal',
    opportunity_kind: 'benefit',
    is_pointer: true,
    is_lead: false,
    no_cost_status: 'official_starting_path',
    no_cost_evidence:
      'HHS states that LIHEAP can weatherize homes or make minor energy-related home repairs for eligible low-income households. This does not prove that a particular local service is provided with no household payment.',
    reviewed_at: SOURCE_REVIEWED_AT,
    source_reviewed_at: SOURCE_REVIEWED_AT,
    source_reviewed_by: 'GrantFlow official-source review',
    source_review_version: POLICY_VERSION,
    link_status: 'ok',
    last_verified_at: SOURCE_REVIEWED_AT,
    applicant_types: ['individual', 'family', 'homeowner', 'renter'],
    upgrades: ['weatherization', 'minor energy-related repairs', 'eligible heating or cooling repair or replacement'],
    eligibility_bullets: [
      'Eligibility and covered services vary by state, territory, or Tribe.',
      'Priority commonly includes households with high energy burden, older adults, people with disabilities, or young children.',
      'The administering agency must confirm the exact service, household eligibility, and any applicant cost before GrantFlow can show a local offer as no cost.',
      'This federal locator is a starting path, not proof that a specific project has been approved or fully paid.',
    ],
  },
])

const GREEN_HOME_PATTERNS = Object.freeze([
  /\bweatheri[sz]ation\b/i,
  /\binsulation\b/i,
  /\bair[- ]?seal(?:ing)?\b/i,
  /\bheat[- ]?pumps?\b/i,
  /\bgeothermal\b/i,
  /\b(?:heating|cooling|hvac|furnace|air conditioner)\b/i,
  /\bsolar(?: panels?| energy| photovoltaic| pv)?\b/i,
  /\bbattery storage\b/i,
  /\b(?:small|residential|home) wind(?: turbine|mill)?\b/i,
  /\benergy[- ]efficien(?:cy|t)\b/i,
  /\bhome energy (?:upgrade|retrofit|improvement|repair)s?\b/i,
  /\bhigh[- ]efficiency water heater\b/i,
  /\benergy[- ]efficient windows?\b/i,
])

// A primary result needs explicit evidence that the household does not have to
// pay. “Direct install,” “grant funded,” or “does not need to be repaid” alone
// are insufficient because a program may still require a contribution or an
// up-front purchase.
const POSITIVE_NO_COST_PATTERNS = Object.freeze([
  { pattern: /\bno[- ]cost\b/i, label: 'The source explicitly describes the service as no cost.' },
  { pattern: /\bat no cost\b/i, label: 'The source explicitly states that the service is provided at no cost.' },
  { pattern: /\bfree(?:\s+[\w-]+){0,3}\s+(?:weatherization|installation|upgrade|repair|service)s?\b/i, label: 'The source explicitly describes the covered service or installation as free.' },
  { pattern: /\bfree of charge\b/i, label: 'The source explicitly states that the service is free of charge.' },
  { pattern: /\b(?:zero|no) out[- ]of[- ]pocket (?:costs?|expense)\b/i, label: 'The source explicitly states that the household has no out-of-pocket cost.' },
  { pattern: /\b100(?:%| percent) (?:covered|funded)\b/i, label: 'The source states that the covered work is fully funded.' },
  { pattern: /\bfully funded\b/i, label: 'The source states that the covered work is fully funded.' },
  { pattern: /\bfully subsidized\b/i, label: 'The source states that the covered work is fully subsidized.' },
  { pattern: /\bcovered in full\b/i, label: 'The source states that the covered work is covered in full.' },
  { pattern: /\ball (?:eligible )?costs? (?:are )?covered\b/i, label: 'The source states that all eligible costs are covered.' },
  { pattern: /\bprovided (?:free|without charge)\b/i, label: 'The source states that the service is provided without charge.' },
  { pattern: /\bnothing (?:for (?:the )?(?:applicant|homeowner|household) )?to pay\b/i, label: 'The source explicitly states that the household has nothing to pay.' },
])

const NEGATED_COST_PATTERNS = Object.freeze([
  /\bdoes not need to be repaid\b/gi,
  /\bno repayment\b/gi,
  /\bnot (?:a )?loan\b/gi,
  /\bno loan required\b/gi,
  /\bwithout financing\b/gi,
  /\b(?:zero|no) out[- ]of[- ]pocket (?:costs?|expense)\b/gi,
  /\bno (?:down|monthly|up[- ]front) payments?\b/gi,
  /\bno (?:applicant|homeowner|household|customer|participant) contributions?\b/gi,
  /\bwithout (?:an? )?(?:applicant|homeowner|household|customer|participant) contribution\b/gi,
  /\bno cost[- ]?share(?:ing)?\b/gi,
  /\bno matching funds?\b/gi,
  /\bno (?:required )?match\b/gi,
  /\bno co[- ]?pay(?:ment)?\b/gi,
  /\bno purchase required\b/gi,
  /\bnot (?:a )?(?:tax credit|rebate|reimbursement|lease|power purchase agreement|ppa)\b/gi,
  /\bno (?:loans?|financing|leases?|power purchase agreements?|tax credits?|rebates?|reimbursements?)\b/gi,
])

const FORBIDDEN_COST_PATTERNS = Object.freeze([
  { code: 'loan_or_financing', pattern: /\b(?:loan|financing|finance plan|line of credit|credit product|mortgage financing|mortgage loan|property assessed clean energy|pace financing)\b/i },
  { code: 'lease_or_ppa', pattern: /\b(?:lease|leasing|power purchase agreement|solar ppa|\bppa\b)\b/i },
  { code: 'tax_credit', pattern: /\b(?:tax credit|tax deduction|tax incentive)\b/i },
  { code: 'rebate', pattern: /\brebate\b/i },
  { code: 'reimbursement', pattern: /\b(?:reimbursement|reimburse after|post[- ]purchase reimbursement)\b/i },
  { code: 'applicant_payment', pattern: /\b(?:down payment|monthly payment|up[- ]front payment|application fee|installation fee|interest rate|\bapr\b|repayment term|repay the|customer payment|homeowner payment|participant payment)\b/i },
  { code: 'cost_share_or_match', pattern: /\b(?:cost[- ]share|cost sharing|matching funds?|match required|required match|customer contribution|homeowner contribution|household contribution|applicant contribution|participant contribution|co[- ]?pay(?:ment)?|out[- ]of[- ]pocket cost)\b/i },
  { code: 'purchase_required', pattern: /\b(?:purchase required|must purchase|buy first|after purchase|qualifying purchase)\b/i },
])

const RETIRED_PROGRAM_PATTERNS = Object.freeze([
  /\bsolar for all\b/i,
  /\bgreenhouse gas reduction fund\b/i,
])

const OFFICIAL_SOURCE_TRUST = new Set([
  'official_api',
  'official_government',
  'official_portal',
  'official_registry',
])

const REVIEWED_SOURCE_TRUST = new Set([
  'verified',
  'verified_source',
  'verified_directory',
  'manual_curated',
  'curated_verified',
])

const WEB_ORIGIN_PATTERN = /\b(?:web[_ -]?search|live[_ -]?web|web[_ -]?lead|search[_ -]?result|searx|duckduckgo|google|bing)\b/i

function parseStructured(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function asText(value) {
  if (value === null || value === undefined) return ''
  const parsed = parseStructured(value)
  if (parsed && parsed !== value) return asText(parsed)
  if (Array.isArray(value)) return value.map(asText).join(' ')
  if (typeof value === 'object') return Object.values(value).map(asText).join(' ')
  return String(value)
}

function resultText(result = {}) {
  return [
    result.title,
    result.name,
    result.description,
    result.summary,
    result.opportunity_type,
    result.opportunity_kind,
    result.funding_type,
    result.categories,
    result.keywords,
    result.eligibility,
    result.eligibility_text,
    result.eligibility_bullets,
    result.no_cost_evidence,
  ].map(asText).join(' ').replace(/\s+/g, ' ').trim()
}

function cleanNegatedCost(text) {
  return NEGATED_COST_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, ' '),
    String(text || ''),
  )
}

function hostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function isOfficialGovernmentUrl(value) {
  const host = hostname(value)
  return Boolean(
    host && (
      host.endsWith('.gov') ||
      host.endsWith('.mil') ||
      host === 'gov' ||
      /(?:^|\.)[a-z]{2}\.us$/.test(host)
    )
  )
}

function hasGreenHomeRelevance(text) {
  return GREEN_HOME_PATTERNS.some((pattern) => pattern.test(text))
}

function noCostEvidence(text, result = {}) {
  if (result.no_cost_status === 'official_no_cost_path') {
    return result.no_cost_evidence || 'An official source identifies this as a no-cost assistance path.'
  }
  if (result.no_cost_verified === true && result.no_cost_evidence) {
    const explicit = String(result.no_cost_evidence)
    const matched = POSITIVE_NO_COST_PATTERNS.find(({ pattern }) => pattern.test(explicit))
    return matched?.label || null
  }
  const matched = POSITIVE_NO_COST_PATTERNS.find(({ pattern }) => pattern.test(text))
  return matched?.label || null
}

function positiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
}

function structuredCostBlock(result = {}) {
  if (result.is_loan === true || result.is_loan === 1) return 'loan_or_financing'
  if (result.requires_match === true || result.requires_match === 1) return 'cost_share_or_match'
  if (result.requires_cost_share === true || result.requires_cost_share === 1) return 'cost_share_or_match'
  if (result.requires_upfront_payment === true) return 'applicant_payment'
  if (result.reimbursement_only === true) return 'reimbursement'
  if (result.is_tax_credit === true) return 'tax_credit'
  if (result.is_rebate === true) return 'rebate'
  if (result.financing_required === true) return 'loan_or_financing'
  if (result.requires_lease_or_ppa === true) return 'lease_or_ppa'
  if (result.applicant_contribution_required === true) return 'cost_share_or_match'
  if (positiveNumber(result.match_percentage)) return 'cost_share_or_match'
  if (positiveNumber(result.required_match_percentage)) return 'cost_share_or_match'
  if (positiveNumber(result.cost_share_percentage)) return 'cost_share_or_match'
  if (positiveNumber(result.applicant_contribution_percentage)) return 'cost_share_or_match'
  if (positiveNumber(result.customer_contribution_percentage)) return 'cost_share_or_match'
  return null
}

function originText(result = {}) {
  return [
    result.result_source,
    result.record_origin,
    result.source_type,
    result.ingest_source,
  ].map(asText).join(' ').toLowerCase()
}

function declaredTrust(result = {}) {
  return String(
    result.source_trust_tier || result.source_trust || result.trust_level || '',
  ).trim().toLowerCase()
}

function provenanceEntries(result = {}) {
  const provenance = parseStructured(result.field_provenance)
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return []
  return Object.values(provenance).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
}

function contentReviewMetadata(result = {}) {
  const entries = provenanceEntries(result)
  const fromEntries = (keys) => {
    for (const entry of entries) {
      for (const key of keys) {
        if (entry[key]) return entry[key]
      }
    }
    return null
  }
  const locator = result.result_source === 'official_green_home_locator'
  return {
    reviewed_at:
      result.source_reviewed_at ||
      result.content_reviewed_at ||
      result.no_cost_reviewed_at ||
      (locator ? result.reviewed_at : null) ||
      fromEntries(['source_reviewed_at', 'content_reviewed_at', 'reviewed_at']),
    reviewed_by:
      result.source_reviewed_by ||
      result.content_reviewed_by ||
      result.no_cost_reviewed_by ||
      fromEntries(['source_reviewed_by', 'content_reviewed_by', 'reviewed_by']),
    review_version:
      result.source_review_version ||
      result.content_review_version ||
      result.no_cost_review_version ||
      fromEntries(['source_review_version', 'content_review_version', 'review_version']),
  }
}

function hasCompleteContentReview(result = {}) {
  const review = contentReviewMetadata(result)
  return Boolean(review.reviewed_at && review.reviewed_by && review.review_version)
}

function sourceTrust(result = {}) {
  const url = result.source_url || result.url || result.application_url || result.info_url
  const officialUrl = isOfficialGovernmentUrl(url)
  const locator = result.result_source === 'official_green_home_locator'
  if (locator) return hasCompleteContentReview(result) ? 'official_government' : 'unverified_official'

  const webOrigin = result.is_lead === true || WEB_ORIGIN_PATTERN.test(originText(result))
  // A raw search result remains a lead even when it points to a government
  // domain. Link liveness is not content review and cannot promote the claim.
  if (webOrigin) return 'unverified_web'

  const trust = declaredTrust(result)
  if (officialUrl && OFFICIAL_SOURCE_TRUST.has(trust) && hasCompleteContentReview(result)) {
    return 'official_government'
  }
  if (REVIEWED_SOURCE_TRUST.has(trust) && hasCompleteContentReview(result)) {
    return 'verified_source'
  }
  if (result.result_source === 'catalog' || result.result_source === 'curated') {
    return officialUrl ? 'unverified_official' : 'unverified_catalog'
  }
  return officialUrl ? 'unverified_official' : 'unverified_web'
}

function parsedDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function ageCheck(value, now, maxAgeDays, prefix) {
  const date = parsedDate(value)
  if (!date) return { ok: false, reason: prefix + '_date_missing' }
  const current = now instanceof Date ? now : new Date(now)
  if (!Number.isFinite(current.getTime())) return { ok: false, reason: prefix + '_date_invalid' }
  const ageDays = Math.floor((current.getTime() - date.getTime()) / 86_400_000)
  if (ageDays < -1) return { ok: false, reason: prefix + '_date_invalid' }
  if (ageDays > maxAgeDays) return { ok: false, reason: prefix + '_stale', age_days: ageDays }
  return { ok: true, age_days: Math.max(0, ageDays), checked_at: date.toISOString() }
}

function sourceReviewFreshness(result = {}, now = new Date()) {
  return ageCheck(contentReviewMetadata(result).reviewed_at, now, SOURCE_MAX_AGE_DAYS, 'source_review')
}

function linkFreshness(result = {}, now = new Date()) {
  if (result.result_source === 'official_green_home_locator') {
    return ageCheck(result.last_verified_at || result.reviewed_at, now, LINK_MAX_AGE_DAYS, 'source_link')
  }
  const status = String(
    result.link_status || result.verification_status || result.source_link_status || '',
  ).trim().toLowerCase()
  const accepted = ['ok', 'redirect', 'verified', 'verified_live_url', 'live', 'success'].includes(status)
  if (!accepted) return { ok: false, reason: 'source_link_not_verified' }
  return ageCheck(
    result.last_verified_at || result.link_verified_at || result.source_link_verified_at,
    now,
    LINK_MAX_AGE_DAYS,
    'source_link',
  )
}

export function classifyNoCostGreenHomeResult(result = {}, { now = new Date() } = {}) {
  const text = resultText(result)
  if (!hasGreenHomeRelevance(text)) {
    return { status: 'excluded', reason: 'not_green_home_upgrade', policy_version: POLICY_VERSION }
  }

  if (RETIRED_PROGRAM_PATTERNS.some((pattern) => pattern.test(text))) {
    return { status: 'excluded', reason: 'retired_or_rescinded_program', policy_version: POLICY_VERSION }
  }

  const structuredBlock = structuredCostBlock(result)
  if (structuredBlock) {
    return { status: 'excluded', reason: structuredBlock, policy_version: POLICY_VERSION }
  }

  const costScanText = cleanNegatedCost(text)
  const forbidden = FORBIDDEN_COST_PATTERNS.find(({ pattern }) => pattern.test(costScanText))
  if (forbidden) {
    return { status: 'excluded', reason: forbidden.code, policy_version: POLICY_VERSION }
  }

  const evidence = noCostEvidence(text, result)
  if (!evidence) {
    return { status: 'review', reason: 'no_cost_not_proven', policy_version: POLICY_VERSION }
  }

  const trust = sourceTrust(result)
  if (!['official_government', 'verified_source'].includes(trust)) {
    return {
      status: 'review',
      reason: 'source_not_yet_verified',
      no_cost_evidence: evidence,
      source_trust: trust,
      policy_version: POLICY_VERSION,
    }
  }

  const reviewFreshness = sourceReviewFreshness(result, now)
  if (!reviewFreshness.ok) {
    return {
      status: 'review',
      reason: reviewFreshness.reason,
      no_cost_evidence: evidence,
      source_trust: trust,
      source_age_days: reviewFreshness.age_days ?? null,
      policy_version: POLICY_VERSION,
    }
  }

  const link = linkFreshness(result, now)
  if (!link.ok) {
    return {
      status: 'review',
      reason: link.reason,
      no_cost_evidence: evidence,
      source_trust: trust,
      source_age_days: reviewFreshness.age_days,
      link_age_days: link.age_days ?? null,
      policy_version: POLICY_VERSION,
    }
  }

  return {
    status: 'eligible',
    reason: 'explicit_no_cost_no_loan_path',
    no_cost_evidence: evidence,
    source_trust: trust,
    source_verified_at: reviewFreshness.checked_at,
    source_age_days: reviewFreshness.age_days,
    link_verified_at: link.checked_at,
    link_age_days: link.age_days,
    policy_version: POLICY_VERSION,
  }
}

export function officialGreenHomePaths(now = new Date()) {
  return OFFICIAL_GREEN_HOME_PATHS.map((program) => {
    const classification = classifyNoCostGreenHomeResult(program, { now })
    return {
      ...program,
      source_fresh: !String(classification.reason || '').startsWith('source_review_'),
      source_age_days: classification.source_age_days ?? null,
      no_cost_policy: POLICY_VERSION,
      no_cost_classification: classification.status,
      no_cost_reason: classification.reason,
      no_cost_source_trust: classification.source_trust || null,
      no_cost_source_verified_at: classification.source_verified_at || null,
    }
  })
}

export default {
  GREEN_HOME_NO_COST_POLICY_VERSION,
  GREEN_HOME_SEARCH_ITEMS,
  OFFICIAL_GREEN_HOME_PATHS,
  classifyNoCostGreenHomeResult,
  officialGreenHomePaths,
}
