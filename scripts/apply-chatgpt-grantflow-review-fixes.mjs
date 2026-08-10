import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, content) => fs.writeFileSync(file, content)

function replaceOnce(file, before, after, label = before.slice(0, 80)) {
  const source = read(file)
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`${file}: missing expected source for ${label}`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${file}: expected one occurrence for ${label}`)
  }
  write(file, source.slice(0, first) + after + source.slice(first + before.length))
}

const policy = `const POLICY_VERSION = 'green_home_no_cost_v2'
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
  /\\bweatheri[sz]ation\\b/i,
  /\\binsulation\\b/i,
  /\\bair[- ]?seal(?:ing)?\\b/i,
  /\\bheat[- ]?pumps?\\b/i,
  /\\bgeothermal\\b/i,
  /\\b(?:heating|cooling|hvac|furnace|air conditioner)\\b/i,
  /\\bsolar(?: panels?| energy| photovoltaic| pv)?\\b/i,
  /\\bbattery storage\\b/i,
  /\\b(?:small|residential|home) wind(?: turbine|mill)?\\b/i,
  /\\benergy[- ]efficien(?:cy|t)\\b/i,
  /\\bhome energy (?:upgrade|retrofit|improvement|repair)s?\\b/i,
  /\\bhigh[- ]efficiency water heater\\b/i,
  /\\benergy[- ]efficient windows?\\b/i,
])

// A primary result needs explicit evidence that the household does not have to
// pay. “Direct install,” “grant funded,” or “does not need to be repaid” alone
// are insufficient because a program may still require a contribution or an
// up-front purchase.
const POSITIVE_NO_COST_PATTERNS = Object.freeze([
  { pattern: /\\bno[- ]cost\\b/i, label: 'The source explicitly describes the service as no cost.' },
  { pattern: /\\bat no cost\\b/i, label: 'The source explicitly states that the service is provided at no cost.' },
  { pattern: /\\bfree(?:\\s+[\\w-]+){0,3}\\s+(?:weatherization|installation|upgrade|repair|service)s?\\b/i, label: 'The source explicitly describes the covered service or installation as free.' },
  { pattern: /\\bfree of charge\\b/i, label: 'The source explicitly states that the service is free of charge.' },
  { pattern: /\\b(?:zero|no) out[- ]of[- ]pocket (?:costs?|expense)\\b/i, label: 'The source explicitly states that the household has no out-of-pocket cost.' },
  { pattern: /\\b100(?:%| percent) (?:covered|funded)\\b/i, label: 'The source states that the covered work is fully funded.' },
  { pattern: /\\bfully funded\\b/i, label: 'The source states that the covered work is fully funded.' },
  { pattern: /\\bfully subsidized\\b/i, label: 'The source states that the covered work is fully subsidized.' },
  { pattern: /\\bcovered in full\\b/i, label: 'The source states that the covered work is covered in full.' },
  { pattern: /\\ball (?:eligible )?costs? (?:are )?covered\\b/i, label: 'The source states that all eligible costs are covered.' },
  { pattern: /\\bprovided (?:free|without charge)\\b/i, label: 'The source states that the service is provided without charge.' },
  { pattern: /\\bnothing (?:for (?:the )?(?:applicant|homeowner|household) )?to pay\\b/i, label: 'The source explicitly states that the household has nothing to pay.' },
])

const NEGATED_COST_PATTERNS = Object.freeze([
  /\\bdoes not need to be repaid\\b/gi,
  /\\bno repayment\\b/gi,
  /\\bnot (?:a )?loan\\b/gi,
  /\\bno loan required\\b/gi,
  /\\bwithout financing\\b/gi,
  /\\b(?:zero|no) out[- ]of[- ]pocket (?:costs?|expense)\\b/gi,
  /\\bno (?:down|monthly|up[- ]front) payments?\\b/gi,
  /\\bno (?:applicant|homeowner|household|customer|participant) contributions?\\b/gi,
  /\\bwithout (?:an? )?(?:applicant|homeowner|household|customer|participant) contribution\\b/gi,
  /\\bno cost[- ]?share(?:ing)?\\b/gi,
  /\\bno matching funds?\\b/gi,
  /\\bno (?:required )?match\\b/gi,
  /\\bno co[- ]?pay(?:ment)?\\b/gi,
  /\\bno purchase required\\b/gi,
  /\\bnot (?:a )?(?:tax credit|rebate|reimbursement|lease|power purchase agreement|ppa)\\b/gi,
  /\\bno (?:loans?|financing|leases?|power purchase agreements?|tax credits?|rebates?|reimbursements?)\\b/gi,
])

const FORBIDDEN_COST_PATTERNS = Object.freeze([
  { code: 'loan_or_financing', pattern: /\\b(?:loan|financing|finance plan|line of credit|credit product|mortgage financing|mortgage loan|property assessed clean energy|pace financing)\\b/i },
  { code: 'lease_or_ppa', pattern: /\\b(?:lease|leasing|power purchase agreement|solar ppa|\\bppa\\b)\\b/i },
  { code: 'tax_credit', pattern: /\\b(?:tax credit|tax deduction|tax incentive)\\b/i },
  { code: 'rebate', pattern: /\\brebate\\b/i },
  { code: 'reimbursement', pattern: /\\b(?:reimbursement|reimburse after|post[- ]purchase reimbursement)\\b/i },
  { code: 'applicant_payment', pattern: /\\b(?:down payment|monthly payment|up[- ]front payment|application fee|installation fee|interest rate|\\bapr\\b|repayment term|repay the|customer payment|homeowner payment|participant payment)\\b/i },
  { code: 'cost_share_or_match', pattern: /\\b(?:cost[- ]share|cost sharing|matching funds?|match required|required match|customer contribution|homeowner contribution|household contribution|applicant contribution|participant contribution|co[- ]?pay(?:ment)?|out[- ]of[- ]pocket cost)\\b/i },
  { code: 'purchase_required', pattern: /\\b(?:purchase required|must purchase|buy first|after purchase|qualifying purchase)\\b/i },
])

const RETIRED_PROGRAM_PATTERNS = Object.freeze([
  /\\bsolar for all\\b/i,
  /\\bgreenhouse gas reduction fund\\b/i,
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

const WEB_ORIGIN_PATTERN = /\\b(?:web[_ -]?search|live[_ -]?web|web[_ -]?lead|search[_ -]?result|searx|duckduckgo|google|bing)\\b/i

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
  ].map(asText).join(' ').replace(/\\s+/g, ' ').trim()
}

function cleanNegatedCost(text) {
  return NEGATED_COST_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, ' '),
    String(text || ''),
  )
}

function hostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\\./, '')
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
      /(?:^|\\.)[a-z]{2}\\.us$/.test(host)
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
`
write('backend/services/greenHomeNoCostPolicy.js', policy)

const search = `import { searchItemNeeds } from './itemNeedSearch.js'
import { computeMatchDecision } from './matchEngine.js'
import {
  GREEN_HOME_NO_COST_POLICY_VERSION,
  GREEN_HOME_SEARCH_ITEMS,
  classifyNoCostGreenHomeResult,
  officialGreenHomePaths,
} from './greenHomeNoCostPolicy.js'

const OUTBOUND_SEARCH_FIELDS = Object.freeze([
  'profile.state',
  'profile.primary_type',
  'signals.location.state',
  'signals.entityType',
])
const HOUSEHOLD_APPLICANT_TYPES = new Set(['individual', 'family', 'student'])
const CATALOG_VERIFICATION_MAX_IDS = 200

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid)/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString().replace(/\\/$/, '').toLowerCase()
  } catch {
    return ''
  }
}

function keyFor(result = {}) {
  const urlKey = normalizedUrl(
    result.source_url || result.url || result.application_url || result.info_url,
  )
  if (urlKey) return 'url:' + urlKey
  const title = String(result.title || result.name || '').trim().toLowerCase()
  const sponsor = String(result.sponsor || result.source || '').trim().toLowerCase()
  return 'text:' + title + '|' + sponsor
}

function mergeMatchedItems(existing = [], incoming = []) {
  return [...new Set([...existing, ...incoming].map((item) => String(item || '').trim()).filter(Boolean))]
}

function addCandidate(map, result, classification, matchedItem) {
  const key = keyFor(result)
  const previous = map.get(key)
  const candidate = {
    ...result,
    eligibility_status: 'provider_confirmation_required',
    no_cost_classification: classification.status,
    no_cost_reason: classification.reason,
    no_cost_evidence: classification.no_cost_evidence || result.no_cost_evidence || null,
    no_cost_source_trust: classification.source_trust || null,
    no_cost_source_verified_at: classification.source_verified_at || null,
    no_cost_source_age_days: classification.source_age_days ?? null,
    no_cost_policy: GREEN_HOME_NO_COST_POLICY_VERSION,
    matched_green_home_items: mergeMatchedItems(result.matched_green_home_items, [matchedItem]),
  }

  if (!previous) {
    map.set(key, candidate)
    return
  }

  const previousScore = Number(previous.need_score ?? previous.item_relevance_score ?? -1)
  const candidateScore = Number(candidate.need_score ?? candidate.item_relevance_score ?? -1)
  map.set(key, {
    ...(candidateScore > previousScore ? candidate : previous),
    matched_green_home_items: mergeMatchedItems(
      previous.matched_green_home_items,
      candidate.matched_green_home_items,
    ),
  })
}

function cleanState(value) {
  const state = String(value || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(state) ? state : null
}

function broadApplicantType(profileContext = {}) {
  const profile = profileContext.profile || profileContext || {}
  const signals = profileContext.signals || {}
  const raw = String(
    profile.primary_type ||
    profile.applicant_type ||
    profile.profile_type ||
    signals.entityType ||
    '',
  ).trim().toLowerCase().replace(/[_-]+/g, ' ')

  if (/student/.test(raw)) return 'student'
  if (/nonprofit|501|church|ministry/.test(raw)) return 'nonprofit'
  if (/business|company|entrepreneur/.test(raw)) return 'small_business'
  if (/school|college|university|education institution/.test(raw)) return 'school'
  if (/municipal|government|county|city|tribe|tribal/.test(raw)) return 'government'
  if (/family|household|caregiver/.test(raw)) return 'family'
  if (/individual|person|homeowner|renter|tenant/.test(raw)) return 'individual'
  return 'individual'
}

function deriveHouseholdContext(profileContext = {}) {
  const profile = profileContext.profile || profileContext || {}
  const sections = profileContext.sections || {}
  const housing = sections.housing || sections.housing_status || sections.basic_information || {}
  const answers = housing.answers && typeof housing.answers === 'object' ? housing.answers : housing
  const rawStatus = String(
    answers.homeownership_status ||
    answers.housing_status ||
    answers.tenure ||
    profile.homeownership_status ||
    '',
  ).trim().toLowerCase()
  const explicitOwner = [
    answers.is_homeowner,
    answers.owns_home,
    answers.homeowner,
    profile.is_homeowner,
  ].some((value) => value === true || value === 'true' || value === 'yes')
  const explicitRenter = [
    answers.is_renter,
    profile.is_renter,
  ].some((value) => value === true || value === 'true' || value === 'yes')

  let occupancy = 'unknown'
  if (explicitOwner || /owner|own home|mortgage/.test(rawStatus)) occupancy = 'homeowner'
  else if (explicitRenter || /rent|tenant/.test(rawStatus)) occupancy = 'renter'

  const state = cleanState(
    profile.state ||
    profile.state_code ||
    sections.basic_information?.state ||
    sections.basic_information?.answers?.state ||
    profileContext?.signals?.location?.state,
  )
  const applicantType = broadApplicantType(profileContext)

  return {
    occupancy,
    state,
    applicant_type: applicantType,
    household_profile: HOUSEHOLD_APPLICANT_TYPES.has(applicantType),
    provider_must_confirm_eligibility: true,
  }
}

/**
 * External search receives only a broad applicant class and two-letter state.
 * It never receives names, contact details, exact address, income/assets,
 * disability or medical facts, veteran identifiers, document contents, or
 * credentials. Catalog candidates are subsequently reloaded and evaluated
 * against the full server-side profile before promotion.
 */
export function minimizeGreenHomeSearchContext(profileContext = {}) {
  const household = deriveHouseholdContext(profileContext)
  const type = household.applicant_type
  const state = household.state
  return {
    profile: {
      primary_type: type,
      ...(state ? { state } : {}),
    },
    signals: {
      entityType: type,
      location: state ? { state } : {},
    },
  }
}

function catalogResultIds(report = {}) {
  return [...new Set(
    (report.items || [])
      .flatMap((item) => item?.results || [])
      .filter((result) => result?.result_source === 'catalog' && result?.id)
      .map((result) => String(result.id)),
  )].slice(0, CATALOG_VERIFICATION_MAX_IDS)
}

function booleanColumn(value) {
  return value === true || value === 1 || value === '1'
}

function parseArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
}

/**
 * Re-evaluate a persisted catalog candidate with the full server-side profile.
 * The generic item probe receives the privacy-minimized shape because it also
 * drives the external web lane. No catalog result can reach the no-cost policy
 * until this second canonical match has seen the complete profile.
 */
export function canonicalGreenHomeProfileRecheck(
  result,
  profileContext,
  computeMatchDecisionImpl = computeMatchDecision,
) {
  if (!profileContext?.profile) {
    return { ok: false, reason: 'canonical_profile_context_missing' }
  }
  try {
    const match = computeMatchDecisionImpl(profileContext, {
      ...result,
      categories: parseArray(result.categories),
      keywords: parseArray(result.keywords),
      entity_types_allowed: parseArray(result.entity_types_allowed),
      need_types_supported: parseArray(result.need_types_supported),
    })
    if (!match || !match.decision) {
      return { ok: false, reason: 'canonical_profile_recheck_failed' }
    }
    if (String(match.decision).toUpperCase() === 'REJECT') {
      return { ok: false, reason: 'canonical_profile_reject', match }
    }
    return { ok: true, match }
  } catch (error) {
    return {
      ok: false,
      reason: 'canonical_profile_recheck_failed',
      error: error?.message || String(error),
    }
  }
}

/**
 * The item-search response is intentionally compact. Reload the persisted row
 * so payment flags, page-fact evidence, link state, source-trust tier, and every
 * canonical matching field are available before promotion.
 */
export async function loadGreenHomeCatalogVerification(db, report = {}) {
  const ids = catalogResultIds(report)
  const byId = new Map()
  if (ids.length === 0 || !db || typeof db.prepare !== 'function') {
    return { byId, requested: ids.length, enriched: 0, error: null }
  }

  const placeholders = ids.map(() => '?').join(', ')
  try {
    const rows = await db.prepare(
      'SELECT * FROM funding_opportunities WHERE id IN (' + placeholders + ')',
    ).all(...ids)

    for (const row of rows || []) {
      const id = String(row?.id || '')
      if (!id) continue
      byId.set(id, {
        ...row,
        source_url: row.source_url || null,
        application_url: row.application_url || null,
        final_url: row.final_url || null,
        last_verified_at: row.last_verified_at || null,
        link_status: row.link_status || null,
        link_status_code: row.link_status_code ?? null,
        verification_method: row.verification_method || null,
        verified_by: row.verified_by || null,
        verification_status: row.verification_status || null,
        source_trust_tier: row.source_trust_tier || null,
        record_origin: row.record_origin || null,
        requires_match: booleanColumn(row.requires_match),
        is_loan: booleanColumn(row.is_loan),
        eligibility_text: row.eligibility_text || null,
        eligibility_bullets: row.eligibility_bullets || null,
        field_provenance: row.field_provenance || null,
      })
    }
    return { byId, requested: ids.length, enriched: byId.size, error: null }
  } catch (error) {
    return {
      byId,
      requested: ids.length,
      enriched: 0,
      error: error?.message || String(error),
    }
  }
}

function summarizeLanes(report = {}) {
  const items = Array.isArray(report.items) ? report.items : []
  return {
    searched_items: items.length,
    catalog_scanned: items.reduce((sum, item) => sum + Number(item?.lanes?.catalog?.scanned || 0), 0),
    catalog_matched_before_no_cost_policy: items.reduce((sum, item) => sum + Number(item?.lanes?.catalog?.matched || 0), 0),
    web_attempted: items.some((item) => item?.lanes?.web?.attempted === true),
    web_raw: items.reduce((sum, item) => sum + Number(item?.lanes?.web?.raw_results || 0), 0),
    web_matched_before_no_cost_policy: items.reduce((sum, item) => sum + Number(item?.lanes?.web?.matched || 0), 0),
    source_errors: items.flatMap((item) => {
      const errors = []
      if (item?.error) errors.push({ item: item.item, lane: 'item', error: item.error })
      if (item?.lanes?.catalog?.error) errors.push({ item: item.item, lane: 'catalog', error: item.lanes.catalog.error })
      if (item?.lanes?.web?.error) errors.push({ item: item.item, lane: 'web', error: item.lanes.web.error })
      return errors
    }),
  }
}

export async function searchGreenHomeNoCostPrograms(db, {
  profileId,
  profileContext = null,
  timeoutMs = 12000,
  now = new Date(),
  searchItemNeedsImpl = searchItemNeeds,
  officialGreenHomePathsImpl = officialGreenHomePaths,
  computeMatchDecisionImpl = computeMatchDecision,
} = {}) {
  if (!profileId) {
    const error = new Error('profileId is required')
    error.statusCode = 400
    throw error
  }
  if (
    typeof searchItemNeedsImpl !== 'function' ||
    typeof officialGreenHomePathsImpl !== 'function' ||
    typeof computeMatchDecisionImpl !== 'function'
  ) {
    const error = new TypeError('green-home search dependencies must be functions')
    error.statusCode = 500
    throw error
  }

  const household = deriveHouseholdContext(profileContext || {})
  if (!household.household_profile) {
    const error = new Error('Select an individual, family, or student household profile for no-cost home upgrades.')
    error.code = 'green_home_household_profile_required'
    error.statusCode = 422
    throw error
  }

  const outboundSearchContext = minimizeGreenHomeSearchContext(profileContext || {})
  const report = await searchItemNeedsImpl(db, {
    profileId,
    items: GREEN_HOME_SEARCH_ITEMS,
    profileContext: outboundSearchContext,
    variant: 'funding',
    timeoutMs,
  })
  const verification = await loadGreenHomeCatalogVerification(db, report)

  const eligible = new Map()
  const review = new Map()
  const excludedCounts = new Map()
  let canonicalRechecks = 0

  for (const itemReport of report.items || []) {
    for (const result of itemReport.results || []) {
      const persisted = result?.id ? verification.byId.get(String(result.id)) : null
      const enriched = persisted
        ? {
            ...result,
            ...persisted,
            result_source: result.result_source,
            url: persisted.final_url || persisted.application_url || persisted.source_url || result.url,
          }
        : result

      if (persisted && result.result_source === 'catalog') {
        canonicalRechecks += 1
        const recheck = canonicalGreenHomeProfileRecheck(
          enriched,
          profileContext,
          computeMatchDecisionImpl,
        )
        if (!recheck.ok) {
          if (recheck.reason === 'canonical_profile_reject') {
            excludedCounts.set(recheck.reason, (excludedCounts.get(recheck.reason) || 0) + 1)
          } else {
            addCandidate(review, enriched, {
              status: 'review',
              reason: recheck.reason,
              source_trust: null,
            }, itemReport.item)
          }
          continue
        }
        enriched.match_decision = recheck.match.decision
        enriched.match_score = recheck.match.score ?? enriched.match_score ?? null
        enriched.match_explanation = recheck.match.explanation ?? enriched.match_explanation ?? null
        enriched.matcher_version = recheck.match.matcher_version || 'green-home-full-profile-recheck'
      }

      const classification = classifyNoCostGreenHomeResult(enriched, { now })
      if (classification.status === 'eligible') {
        addCandidate(eligible, enriched, classification, itemReport.item)
      } else if (classification.status === 'review') {
        addCandidate(review, enriched, classification, itemReport.item)
      } else {
        excludedCounts.set(
          classification.reason,
          (excludedCounts.get(classification.reason) || 0) + 1,
        )
      }
    }
  }

  const officialPaths = officialGreenHomePathsImpl(now)
  for (const program of officialPaths) {
    const classification = classifyNoCostGreenHomeResult(program, { now })
    addCandidate(
      classification.status === 'eligible' ? eligible : review,
      program,
      classification,
      'official low-income home energy assistance',
    )
  }

  const programs = [...eligible.values()].sort((a, b) => {
    const aLocator = a.result_source === 'official_green_home_locator' ? 1 : 0
    const bLocator = b.result_source === 'official_green_home_locator' ? 1 : 0
    if (aLocator !== bLocator) return bLocator - aLocator
    const aOfficial = a.no_cost_source_trust === 'official_government' ? 1 : 0
    const bOfficial = b.no_cost_source_trust === 'official_government' ? 1 : 0
    if (aOfficial !== bOfficial) return bOfficial - aOfficial
    return Number(b.need_score ?? b.item_relevance_score ?? 0) - Number(a.need_score ?? a.item_relevance_score ?? 0)
  })

  const reviewRows = [...review.values()]
  const laneSummary = summarizeLanes(report)
  laneSummary.catalog_verification_requested = verification.requested
  laneSummary.catalog_verification_enriched = verification.enriched
  laneSummary.catalog_full_profile_rechecks = canonicalRechecks
  if (verification.error) {
    laneSummary.source_errors.push({
      item: 'green_home_catalog_verification',
      lane: 'catalog_verification',
      error: verification.error,
    })
  }

  return {
    success: true,
    profile_id: String(profileId),
    policy_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    strict_no_cost: true,
    household,
    search_privacy: {
      outbound_fields: [...OUTBOUND_SEARCH_FIELDS],
      sensitive_fields_transmitted: false,
      outbound_context: outboundSearchContext,
      catalog_matching_context: 'full_server_side_profile_recheck',
    },
    searched_items: [...GREEN_HOME_SEARCH_ITEMS],
    count: programs.length,
    programs,
    review_count: reviewRows.length,
    review_reasons: Object.entries(
      reviewRows.reduce((acc, row) => {
        const reason = row.no_cost_reason || 'review_required'
        acc[reason] = (acc[reason] || 0) + 1
        return acc
      }, {}),
    ).map(([reason, count]) => ({ reason, count })),
    excluded_count: [...excludedCounts.values()].reduce((sum, count) => sum + count, 0),
    excluded_reasons: [...excludedCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    search_coverage: laneSummary,
    source_freshness: officialPaths.map((path) => ({
      id: path.id,
      reviewed_at: path.reviewed_at,
      fresh: path.source_fresh,
      age_days: path.source_age_days,
      classification: path.no_cost_classification,
      reason: path.no_cost_reason,
    })),
    retired_program_guard: {
      solar_for_all: 'excluded_as_terminated_or_rescinded',
    },
    notice:
      'Only explicitly no-cost, non-loan paths are shown. Link liveness alone never establishes source trust or content freshness. Tax credits, rebates, reimbursement-only offers, leases, financing, required contributions, and sources with unknown, stale, or unreviewed terms are withheld from primary results.',
    searched_at: new Date().toISOString(),
  }
}

export default {
  searchGreenHomeNoCostPrograms,
}
`
write('backend/services/greenHomeNoCostSearch.js', search)

replaceOnce(
  'backend/config/urlRules.js',
  `  if (addr.includes(':')) {
    // IPv6
    if (addr === '::1' || addr === '::') return true // loopback / unspecified
    if (addr.startsWith('fe80')) return true // link-local
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true // unique-local fc00::/7
    return false
  }`,
  `  if (addr.includes(':')) {
    // IPv6 zone identifiers (for example fe80::1%eth0) do not change the
    // address range. Strip the zone before evaluating the first hextet.
    const scoped = addr.split('%')[0]
    if (scoped === '::1' || scoped === '::') return true // loopback / unspecified
    const firstText = scoped.split(':')[0]
    const first = Number.parseInt(firstText || '0', 16)
    if (!Number.isFinite(first)) return true // malformed IPv6 literal -> fail closed
    if ((first & 0xffc0) === 0xfe80) return true // link-local fe80::/10 (fe80-febf)
    if ((first & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
    return false
  }`,
  'complete IPv6 private-range check',
)

for (const [before, after] of [
  ["    return { ok: false, reason: 'image_body_read_failed' }", "    return discardAndReturn(res, { ok: false, reason: 'image_body_read_failed' })"],
  ["    return { ok: false, reason: 'website_body_read_failed' }", "    return discardAndReturn(res, { ok: false, reason: 'website_body_read_failed' })"],
  ["    return { ok: false, reason: 'cover_body_read_failed' }", "    return discardAndReturn(imgRes, { ok: false, reason: 'cover_body_read_failed' })"],
]) {
  replaceOnce('backend/services/avatarCrawler.js', before, after, before)
}

replaceOnce(
  'backend/services/orgLogoFetcher.js',
  "import { readBufferCapped } from './http/safeFetch.js'",
  "import { discardResponseBody, readBufferCapped } from './http/safeFetch.js'\n\nasync function discardAndReturn(response, result) {\n  await discardResponseBody(response)\n  return result\n}",
  'org-logo response disposal import',
)
replaceOnce(
  'backend/services/orgLogoFetcher.js',
  "  if (!response?.ok) return { ok: false, reason: 'image_fetch_failed' }",
  "  if (!response) return { ok: false, reason: 'image_fetch_failed' }\n  if (!response.ok) return discardAndReturn(response, { ok: false, reason: 'image_fetch_failed' })",
)
replaceOnce(
  'backend/services/orgLogoFetcher.js',
  "  if (!looksImage) return { ok: false, reason: 'not_image' }",
  "  if (!looksImage) return discardAndReturn(response, { ok: false, reason: 'not_image' })",
)
replaceOnce(
  'backend/services/orgLogoFetcher.js',
  "  const imageBody = await readBufferCapped(response, MAX_IMAGE_BYTES).catch(() => null)\n  if (!imageBody) return { ok: false, reason: 'image_read_failed' }",
  "  let imageBody\n  try {\n    imageBody = await readBufferCapped(response, MAX_IMAGE_BYTES)\n  } catch {\n    return discardAndReturn(response, { ok: false, reason: 'image_read_failed' })\n  }",
)
replaceOnce(
  'backend/services/orgLogoFetcher.js',
  "  if (!pageResponse?.ok) return { ok: false, reason: 'website_fetch_failed' }",
  "  if (!pageResponse) return { ok: false, reason: 'website_fetch_failed' }\n  if (!pageResponse.ok) return discardAndReturn(pageResponse, { ok: false, reason: 'website_fetch_failed' })",
)
replaceOnce(
  'backend/services/orgLogoFetcher.js',
  "  const pageBody = await readBufferCapped(pageResponse, MAX_HTML_BYTES).catch(() => null)\n  if (!pageBody) return { ok: false, reason: 'website_read_failed' }",
  "  let pageBody\n  try {\n    pageBody = await readBufferCapped(pageResponse, MAX_HTML_BYTES)\n  } catch {\n    return discardAndReturn(pageResponse, { ok: false, reason: 'website_read_failed' })\n  }",
)

replaceOnce(
  'src/pages/GreenHomePrograms.jsx',
  "  const eligibility = Array.isArray(program.eligibility_bullets)\n    ? program.eligibility_bullets\n    : []",
  "  const eligibility = Array.isArray(program.eligibility_bullets)\n    ? program.eligibility_bullets\n    : []\n  const sourceLabel = program.no_cost_source_trust === 'official_government'\n    ? 'Open official source'\n    : 'Open reviewed source'",
)
replaceOnce(
  'src/pages/GreenHomePrograms.jsx',
  '                Open official source',
  '                {sourceLabel}',
)
replaceOnce(
  'src/pages/GreenHomePrograms.jsx',
  "    setLoading(true)\n    setError(null)",
  "    setLoading(true)\n    setError(null)\n    setResult(null)",
)
replaceOnce(
  'src/pages/GreenHomePrograms.jsx',
  "      const message = searchError?.message || 'The green-home search could not be completed.'\n      setError(message)",
  "      const message = searchError?.message || 'The green-home search could not be completed.'\n      setResult(null)\n      setError(message)",
)
replaceOnce(
  'src/pages/GreenHomePrograms.jsx',
  "  official_source_review_stale: 'Official source review needs refreshing',",
  "  official_source_review_stale: 'Official source review needs refreshing',\n  source_review_date_missing: 'No current content review is recorded',\n  source_review_stale: 'The source content review is stale',\n  source_link_not_verified: 'The source link has not been verified',\n  source_link_date_missing: 'The source link has no verification date',\n  source_link_stale: 'The source link verification is stale',\n  canonical_profile_context_missing: 'The full profile could not be rechecked',\n  canonical_profile_recheck_failed: 'The full profile recheck could not be completed',",
)

replaceOnce(
  'src/nav/navConfig.js',
  "  title: 'No-Cost Green Home Upgrades',\n  routeName: 'GreenHomePrograms',",
  "  title: 'No-Cost Green Home Upgrades',\n  i18nKey: 'nav.greenHomePrograms',\n  routeName: 'GreenHomePrograms',",
)
replaceOnce(
  'src/nav/navConfig.js',
  "export const ROUTE_LABEL_I18N = Object.freeze({\n  ...base.ROUTE_LABEL_I18N,\n})",
  "export const ROUTE_LABEL_I18N = Object.freeze({\n  ...base.ROUTE_LABEL_I18N,\n  GreenHomePrograms: 'nav.greenHomePrograms',\n})",
)
replaceOnce(
  'src/nav/endUserNavConfig.js',
  "        title: 'No-Cost Green Home Upgrades',\n        routeName: 'GreenHomePrograms',",
  "        title: 'No-Cost Green Home Upgrades',\n        i18nKey: 'nav.greenHomePrograms',\n        routeName: 'GreenHomePrograms',",
)
replaceOnce(
  'src/pages/index.jsx',
  'const ROUTE_NAMES = new Set([',
  'export const ROUTE_NAMES = new Set([',
)

const navigationTest = `import { describe, expect, it } from 'vitest'
import {
  NAV_GROUPS,
  ROUTE_LABELS,
  getBreadcrumbSegments,
  getGroupIdForRoute,
} from './navConfig.js'
import { END_USER_NAV_GROUPS } from './endUserNavConfig.js'
import { ROUTE_NAMES } from '../pages/index.jsx'

function routeItems(groups, routeName) {
  return groups.flatMap((group) => group.items || []).filter((item) => item.routeName === routeName)
}

describe('No-Cost Green Home navigation', () => {
  it('appears once in the full/admin Find Funding menu', () => {
    const items = routeItems(NAV_GROUPS, 'GreenHomePrograms')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'No-Cost Green Home Upgrades',
      i18nKey: 'nav.greenHomePrograms',
      url: '/GreenHomePrograms',
    })
    expect(getGroupIdForRoute('/GreenHomePrograms')).toBe('find')
    expect(ROUTE_LABELS.GreenHomePrograms).toBe('No-Cost Green Home Upgrades')
  })

  it('appears once in the end-user My Funding menu', () => {
    const items = routeItems(END_USER_NAV_GROUPS, 'GreenHomePrograms')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'No-Cost Green Home Upgrades',
      i18nKey: 'nav.greenHomePrograms',
      url: '/GreenHomePrograms',
    })
  })

  it('builds a truthful Find Funding breadcrumb', () => {
    const crumbs = getBreadcrumbSegments('/GreenHomePrograms')
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      'Home',
      'Find Funding',
      'No-Cost Green Home Upgrades',
    ])
    expect(crumbs.at(-1)).toMatchObject({
      path: '/GreenHomePrograms',
      labelI18nKey: 'nav.greenHomePrograms',
      isCurrent: true,
    })
  })

  it('registers and labels every route exposed by either sidebar', () => {
    const routeNames = [...NAV_GROUPS, ...END_USER_NAV_GROUPS]
      .flatMap((group) => group.items || [])
      .map((item) => item.routeName)
    for (const routeName of new Set(routeNames)) {
      expect(ROUTE_LABELS[routeName], 'missing label for ' + routeName).toBeTruthy()
      expect(ROUTE_NAMES.has(routeName), 'missing route registration for ' + routeName).toBe(true)
    }
  })
})
`
write('src/nav/greenHomeNavigation.test.js', navigationTest)

const localeTranslations = {
  de: 'Kostenlose nachhaltige Modernisierungen',
  en: 'No-Cost Green Home Upgrades',
  es: 'Mejoras ecológicas del hogar sin costo',
  fr: 'Améliorations écologiques du logement sans frais',
  hi: 'बिना लागत के हरित गृह सुधार',
  pt: 'Melhorias sustentáveis sem custo',
  ru: 'Бесплатные экологичные улучшения дома',
  uk: 'Безкоштовні екологічні покращення оселі',
  zh: '免费绿色住宅升级',
}
for (const [locale, translation] of Object.entries(localeTranslations)) {
  const file = 'src/i18n/locales/' + locale + '.json'
  const original = JSON.parse(read(file))
  const next = {}
  for (const [key, value] of Object.entries(original)) {
    next[key] = value
    if (key === 'nav.fundingLibrary') next['nav.greenHomePrograms'] = translation
  }
  if (!next['nav.greenHomePrograms']) next['nav.greenHomePrograms'] = translation
  write(file, JSON.stringify(next, null, 2) + '\n')
}

replaceOnce(
  'backend/tests/orgLogoFetcher.test.js',
  "      expect(typeof result.reason).toBe('string')",
  "      expect(result.reason).toBe('image_too_small')",
)

replaceOnce(
  'backend/tests/safeFetchSsrf.test.js',
  "} from '../services/http/safeFetch.js'",
  "} from '../services/http/safeFetch.js'\nimport { isPrivateIp } from '../config/urlRules.js'",
)
write(
  'backend/tests/safeFetchSsrf.test.js',
  read('backend/tests/safeFetchSsrf.test.js') + `\n\ndescribe('canonical IPv6 private-range classification', () => {\n  it.each(['fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'fe80::1%eth0'])(\n    'blocks the complete link-local range for %s',\n    (address) => {\n      expect(isPrivateIp(address)).toBe(true)\n    },\n  )\n\n  it.each(['fc00::1', 'fdff::1'])(\n    'continues to block unique-local IPv6 address %s',\n    (address) => {\n      expect(isPrivateIp(address)).toBe(true)\n    },\n  )\n})\n`,
)

const policyTests = `import { describe, expect, it } from 'vitest'
import {
  GREEN_HOME_NO_COST_POLICY_VERSION,
  classifyNoCostGreenHomeResult,
  officialGreenHomePaths,
} from '../services/greenHomeNoCostPolicy.js'

const NOW = new Date('2026-08-10T00:00:00Z')

function classify(result) {
  return classifyNoCostGreenHomeResult(result, { now: NOW })
}

function official(overrides = {}) {
  return {
    title: 'No-cost heat-pump direct installation',
    description: 'Income-qualified households receive a heat pump at no cost. No repayment.',
    source_url: 'https://energy.example.gov/programs/heat-pump',
    result_source: 'catalog',
    source_trust_tier: 'official_portal',
    source_reviewed_at: '2026-08-09T00:00:00Z',
    source_reviewed_by: 'test-reviewer',
    source_review_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    link_status: 'ok',
    last_verified_at: '2026-08-09T00:00:00Z',
    ...overrides,
  }
}

describe('green-home strict no-cost policy', () => {
  it('accepts a freshly reviewed official source with explicit no-payment evidence', () => {
    expect(classify(official())).toMatchObject({
      status: 'eligible',
      reason: 'explicit_no_cost_no_loan_path',
      source_trust: 'official_government',
      source_age_days: 1,
      policy_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    })
  })

  it.each([
    ['loan_or_financing', { description: 'No-cost solar panels through PACE financing and monthly payments.' }],
    ['lease_or_ppa', { description: 'Solar panels provided through a power purchase agreement.' }],
    ['tax_credit', { description: 'Heat pump federal tax credit for eligible purchases.' }],
    ['rebate', { description: 'Heat pump rebate after installation.' }],
    ['reimbursement', { description: 'Reimbursement available after purchase.' }],
    ['cost_share_or_match', { description: 'Insulation grant with a 20 percent homeowner contribution.' }],
    ['purchase_required', { description: 'Solar grant after a qualifying purchase.' }],
  ])('excludes %s offers even when the technology is relevant', (reason, overrides) => {
    expect(classify(official(overrides))).toMatchObject({ status: 'excluded', reason })
  })

  it('scans persisted eligibility prose for contradictory payment terms', () => {
    expect(classify(official({
      title: 'No-cost heat pump program',
      description: 'The provider advertises a free heat pump installation.',
      eligibility_text: 'Approved households must make a qualifying purchase and pay an installation fee.',
    }))).toMatchObject({ status: 'excluded', reason: 'applicant_payment' })
  })

  it('does not mistake explicit no-payment language for a payment requirement', () => {
    expect(classify(official({
      description: 'No-cost insulation with no loan required, no monthly payment, no homeowner contribution, no matching funds, no purchase required, and zero out-of-pocket cost.',
    }))).toMatchObject({ status: 'eligible' })
  })

  it('requires explicit no-payment evidence rather than direct-install or grant wording alone', () => {
    expect(classify(official({
      title: 'Heat pump direct installation program',
      description: 'Direct-install heat pump program. Contact the provider for applicant costs.',
    }))).toMatchObject({ status: 'review', reason: 'no_cost_not_proven' })
    expect(classify(official({
      title: 'Residential solar program',
      description: 'Grant-funded residential solar program. Cost terms vary.',
    }))).toMatchObject({ status: 'review', reason: 'no_cost_not_proven' })
  })

  it('recognizes hyphenated heat pumps and qualified free-installation wording', () => {
    expect(classify(official({
      title: 'Heat-pumps for qualifying households',
      description: 'Free residential heat pump installation for qualifying households.',
    }))).toMatchObject({ status: 'eligible' })
  })

  it('holds raw web leads for review even when a government-domain snippet says free', () => {
    expect(classify({
      title: 'Free residential wind turbine installation',
      description: 'Free small wind installation for selected homeowners.',
      source_url: 'https://energy.example.gov/wind',
      result_source: 'web_search',
      source_trust_tier: 'official_portal',
      source_reviewed_at: '2026-08-09T00:00:00Z',
      source_reviewed_by: 'test-reviewer',
      source_review_version: GREEN_HOME_NO_COST_POLICY_VERSION,
      link_status: 'ok',
      last_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({
      status: 'review',
      reason: 'source_not_yet_verified',
      source_trust: 'unverified_web',
    })
  })

  it('does not promote a reachable non-government page without explicit source review', () => {
    expect(classify({
      title: 'No-cost nonprofit weatherization program',
      description: 'Free weatherization service for qualifying households.',
      source_url: 'https://community-energy.example/weatherization',
      result_source: 'catalog',
      verified_url: 1,
      link_status: 'ok',
      last_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({
      status: 'review',
      reason: 'source_not_yet_verified',
      source_trust: 'unverified_catalog',
    })
  })

  it('accepts a non-government source only with explicit trust, content review, and link proof', () => {
    expect(classify({
      title: 'No-cost nonprofit weatherization program',
      description: 'Free weatherization service for qualifying households.',
      source_url: 'https://community-energy.example/weatherization',
      result_source: 'catalog',
      source_trust_tier: 'manual_curated',
      source_reviewed_at: '2026-08-09T00:00:00Z',
      source_reviewed_by: 'test-reviewer',
      source_review_version: GREEN_HOME_NO_COST_POLICY_VERSION,
      link_status: 'ok',
      last_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({ status: 'eligible', source_trust: 'verified_source' })
  })

  it('separates content-review freshness from link liveness', () => {
    expect(classify(official({ source_reviewed_at: null }))).toMatchObject({
      status: 'review', reason: 'source_review_date_missing',
    })
    expect(classify(official({ source_reviewed_at: '2026-01-01T00:00:00Z' }))).toMatchObject({
      status: 'review', reason: 'source_review_stale',
    })
    expect(classify(official({ link_status: 'broken' }))).toMatchObject({
      status: 'review', reason: 'source_link_not_verified',
    })
    expect(classify(official({ last_verified_at: '2026-01-01T00:00:00Z' }))).toMatchObject({
      status: 'review', reason: 'source_link_stale',
    })
  })

  it('excludes terminated Solar for All references', () => {
    expect(classify(official({
      title: 'Solar for All',
      description: 'Free residential solar panels under the Greenhouse Gas Reduction Fund.',
    }))).toMatchObject({ status: 'excluded', reason: 'retired_or_rescinded_program' })
  })

  it('runs official locator paths through the same classifier', () => {
    const current = officialGreenHomePaths(NOW)
    expect(current.find((path) => path.id === 'doe-weatherization-assistance')).toMatchObject({
      no_cost_classification: 'eligible',
      no_cost_reason: 'explicit_no_cost_no_loan_path',
    })
    expect(current.find((path) => path.id === 'hhs-liheap-weatherization-repairs')).toMatchObject({
      no_cost_classification: 'review',
      no_cost_reason: 'no_cost_not_proven',
    })

    const stale = officialGreenHomePaths(new Date('2026-12-31T00:00:00Z'))
    expect(stale.find((path) => path.id === 'doe-weatherization-assistance')).toMatchObject({
      no_cost_classification: 'review',
      no_cost_reason: 'source_review_stale',
    })
  })
})
`
write('backend/tests/greenHomeNoCostPolicy.test.js', policyTests)

const searchTests = `import { describe, expect, it, vi } from 'vitest'
import {
  canonicalGreenHomeProfileRecheck,
  minimizeGreenHomeSearchContext,
  searchGreenHomeNoCostPrograms,
} from '../services/greenHomeNoCostSearch.js'
import {
  GREEN_HOME_NO_COST_POLICY_VERSION,
  officialGreenHomePaths,
} from '../services/greenHomeNoCostPolicy.js'

const NOW = new Date('2026-08-10T00:00:00Z')

function reportWith(results) {
  return {
    profile_id: 'profile-1',
    items: [{
      item: 'home weatherization',
      results,
      lanes: {
        catalog: { scanned: 9, matched: 4, error: null },
        web: { attempted: true, raw_results: 12, matched: 3, error: null },
      },
    }],
  }
}

function trustedCatalog(overrides = {}) {
  return {
    id: 'direct-install',
    title: 'No-cost insulation direct install',
    description: 'Income-qualified households receive insulation at no cost.',
    source_url: 'https://energy.example.gov/no-cost-insulation',
    result_source: 'catalog',
    source_trust_tier: 'official_portal',
    source_reviewed_at: '2026-08-09T00:00:00Z',
    source_reviewed_by: 'test-reviewer',
    source_review_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    link_status: 'ok',
    last_verified_at: '2026-08-09T00:00:00Z',
    need_score: 40,
    ...overrides,
  }
}

describe('searchGreenHomeNoCostPrograms', () => {
  it('shows only proven no-cost paths and keeps LIHEAP as review-only', async () => {
    const searchItemNeedsImpl = vi.fn().mockResolvedValue(reportWith([
      trustedCatalog(),
      trustedCatalog({
        id: 'tax-credit',
        title: 'Residential clean energy tax credit',
        description: 'Tax credit for purchasing rooftop solar panels.',
      }),
      trustedCatalog({
        id: 'unknown-cost',
        title: 'Heat pump assistance program',
        description: 'Heat pump assistance may be available. Contact the provider for cost terms.',
      }),
      {
        id: 'unknown-web',
        title: 'Free residential wind installation',
        description: 'Free small wind installation for selected homeowners.',
        url: 'https://unknown.example/wind',
        result_source: 'web_search',
        need_score: 70,
      },
    ]))

    const privateContext = {
      profile: {
        id: 'profile-1',
        display_name: 'Private Household Name',
        primary_email: 'private@example.com',
        street_address: '123 Private Lane',
        state: 'TN',
        exact_income: 12345,
        disability_diagnosis: 'private diagnosis',
        veteran_service_number: 'private veteran identifier',
        is_homeowner: true,
        primary_type: 'family',
      },
      sections: { documents: { uploaded_text: 'private uploaded document content' } },
    }

    const result = await searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      profileContext: privateContext,
      now: NOW,
      searchItemNeedsImpl,
      officialGreenHomePathsImpl: officialGreenHomePaths,
    })

    const searchOptions = searchItemNeedsImpl.mock.calls[0][1]
    expect(searchOptions.profileContext).toEqual({
      profile: { primary_type: 'family', state: 'TN' },
      signals: { entityType: 'family', location: { state: 'TN' } },
    })
    expect(JSON.stringify(searchOptions.profileContext)).not.toMatch(
      /Private Household|private@example|Private Lane|12345|diagnosis|veteran identifier|uploaded document/i,
    )
    expect(result.programs.map((program) => program.id)).toEqual([
      'doe-weatherization-assistance',
      'direct-install',
    ])
    expect(result.review_reasons).toEqual(expect.arrayContaining([
      { reason: 'no_cost_not_proven', count: 2 },
      { reason: 'source_not_yet_verified', count: 1 },
    ]))
    expect(result.excluded_reasons).toContainEqual({ reason: 'tax_credit', count: 1 })
    expect(result.search_coverage).toMatchObject({
      searched_items: 1,
      catalog_verification_requested: 3,
      catalog_verification_enriched: 0,
      catalog_full_profile_rechecks: 0,
    })
    expect(result.search_privacy).toMatchObject({
      sensitive_fields_transmitted: false,
      catalog_matching_context: 'full_server_side_profile_recheck',
    })
  })

  it('rejects organization profiles before household locators or external search are added', async () => {
    const searchItemNeedsImpl = vi.fn()
    await expect(searchGreenHomeNoCostPrograms(null, {
      profileId: 'org-1',
      profileContext: { profile: { primary_type: 'nonprofit', state: 'TN' } },
      searchItemNeedsImpl,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'green_home_household_profile_required',
    })
    expect(searchItemNeedsImpl).not.toHaveBeenCalled()
  })

  it('rechecks persisted catalog candidates with the complete server-side profile', async () => {
    const report = reportWith([trustedCatalog()])
    const row = {
      ...trustedCatalog(),
      categories: '[]',
      keywords: '[]',
      entity_types_allowed: '["individual"]',
      need_types_supported: '["weatherization"]',
    }
    const db = {
      prepare: vi.fn(() => ({ all: vi.fn().mockResolvedValue([row]) })),
    }
    const computeMatchDecisionImpl = vi.fn((context) => {
      expect(context.profile.exact_income).toBe(12345)
      expect(context.profile.disability_diagnosis).toBe('private diagnosis')
      return { decision: 'REJECT', score: 0, explanation: 'source-defined hard mismatch' }
    })

    const result = await searchGreenHomeNoCostPrograms(db, {
      profileId: 'profile-1',
      profileContext: {
        profile: {
          primary_type: 'family',
          state: 'TN',
          exact_income: 12345,
          disability_diagnosis: 'private diagnosis',
        },
      },
      now: NOW,
      searchItemNeedsImpl: async () => report,
      officialGreenHomePathsImpl: () => [],
      computeMatchDecisionImpl,
    })

    expect(computeMatchDecisionImpl).toHaveBeenCalledTimes(1)
    expect(result.programs).toHaveLength(0)
    expect(result.excluded_reasons).toContainEqual({ reason: 'canonical_profile_reject', count: 1 })
    expect(result.search_coverage.catalog_full_profile_rechecks).toBe(1)
  })

  it('deduplicates the same source and ranks an official locator first', async () => {
    const shared = trustedCatalog({
      id: 'shared',
      title: 'Free weatherization and heat-pump installation',
      description: 'A no-cost program for qualifying households.',
      source_url: 'https://energy.example.gov/free-upgrades?utm_source=test',
    })
    const result = await searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      profileContext: { profile: { primary_type: 'family', state: 'TN' } },
      now: NOW,
      searchItemNeedsImpl: async () => ({
        items: [
          { item: 'weatherization', results: [{ ...shared, need_score: 25 }], lanes: {} },
          { item: 'heat pump', results: [{ ...shared, source_url: 'https://energy.example.gov/free-upgrades', need_score: 45 }], lanes: {} },
        ],
      }),
      officialGreenHomePathsImpl: officialGreenHomePaths,
    })

    expect(result.programs.map((program) => program.id)).toEqual([
      'doe-weatherization-assistance',
      'shared',
    ])
    expect(result.programs[1].need_score).toBe(45)
    expect(result.programs[1].matched_green_home_items).toEqual(['weatherization', 'heat pump'])
  })

  it('exposes catalog metadata-query failure as partial coverage', async () => {
    const db = { prepare: vi.fn(() => ({ all: vi.fn().mockRejectedValue(new Error('db unavailable')) })) }
    const result = await searchGreenHomeNoCostPrograms(db, {
      profileId: 'profile-1',
      profileContext: { profile: { primary_type: 'family', state: 'TN' } },
      now: NOW,
      searchItemNeedsImpl: async () => reportWith([trustedCatalog()]),
      officialGreenHomePathsImpl: () => [],
    })
    expect(result.search_coverage.source_errors).toContainEqual(expect.objectContaining({
      lane: 'catalog_verification',
      error: 'db unavailable',
    }))
  })

  it('minimizes malformed state and organization values safely', () => {
    expect(minimizeGreenHomeSearchContext({
      profile: { primary_type: 'Church Ministry 501(c)(3)', state: 'Tennessee' },
    })).toEqual({
      profile: { primary_type: 'nonprofit' },
      signals: { entityType: 'nonprofit', location: {} },
    })
  })

  it('exposes the canonical recheck helper for direct regression coverage', () => {
    const matcher = vi.fn(() => ({ decision: 'ACCEPT', score: 88 }))
    expect(canonicalGreenHomeProfileRecheck(
      { title: 'Weatherization', categories: '[]', keywords: '[]' },
      { profile: { primary_type: 'family' } },
      matcher,
    )).toMatchObject({ ok: true, match: { decision: 'ACCEPT', score: 88 } })
  })

  it('requires a profile id and valid injected dependencies', async () => {
    await expect(searchGreenHomeNoCostPrograms(null, {})).rejects.toMatchObject({ statusCode: 400 })
    await expect(searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      profileContext: { profile: { primary_type: 'family' } },
      searchItemNeedsImpl: null,
    })).rejects.toMatchObject({ statusCode: 500 })
  })
})
`
write('backend/tests/greenHomeNoCostSearch.test.js', searchTests)

replaceOnce(
  'docs/green-home-no-cost-programs.md',
  '**Policy version:** `green_home_no_cost_v1`  \n**Source review date:** 2026-08-09',
  '**Policy version:** `green_home_no_cost_v2`  \n**Source review date:** 2026-08-10',
)
replaceOnce(
  'docs/green-home-no-cost-programs.md',
  '2. The source explicitly says that the assistance or covered work is free, no cost, fully funded, grant funded, direct install, or does not require repayment.',
  '2. The reviewed source explicitly establishes that the applicant pays nothing for the covered assistance or work. “Grant funded,” “direct install,” and non-repayment wording are supporting signals only; they are not sufficient when an applicant contribution, purchase, fee, or other payment may still be required.',
)
replaceOnce(
  'docs/green-home-no-cost-programs.md',
  'HHS states that LIHEAP may weatherize homes or provide minor energy-related home repairs. Available work, eligibility rules, and application procedures vary by the state, territory, or Tribe administering the benefit.\n\nThese are typed as a provider/application directory and a public-benefit path. Their presence does not claim that the selected household is approved or that a particular technology will be installed.',
  'HHS states that LIHEAP may weatherize homes or provide minor energy-related home repairs. Available work, eligibility rules, application procedures, and household costs vary by the state, territory, or Tribe administering the benefit. The federal LIHEAP page is therefore retained as a review-only starting path until a state, Tribal, or local source explicitly proves that the particular service requires no household payment.\n\nWAP is typed as an official provider/application directory with explicit federal no-cost evidence. LIHEAP is typed as a public-benefit locator and remains review-only at the federal level. Neither path claims that the selected household is approved or that a particular technology will be installed.',
)
replaceOnce(
  'docs/green-home-no-cost-programs.md',
  '- source-review freshness;',
  '- independently recorded content-review freshness and link-verification freshness;',
)

replaceOnce(
  'docs/purpose-contract.md',
  '- Vercel frontend, frontend deployment metadata, Railway `/api/version`, Railway health and readiness, and production workers identify the exact final `main` SHA.',
  '- Vercel frontend, frontend deployment metadata, Railway `/api/version`, Railway health and readiness, and production workers identify the exact final `main` SHA.\n- The production database reports a canonical migration-set identity derived from the ordered applied migration filenames and file hashes, and that identity matches the release manifest generated for the same SHA.\n- The release-evidence packet is a content-addressed artifact whose SHA-256 is recorded in the release manifest and returned by the deployment-proof check; a mutable document title or health response is not artifact identity.',
)

console.log('Applied asserted GrantFlow review fixes successfully.')
