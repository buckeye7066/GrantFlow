const POLICY_VERSION = 'green_home_no_cost_v1'
const SOURCE_REVIEWED_AT = '2026-08-09'
const SOURCE_MAX_AGE_DAYS = 60

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
    opportunity_kind: 'directory',
    is_pointer: true,
    is_lead: false,
    no_cost_status: 'official_no_cost_path',
    no_cost_evidence:
      'DOE identifies WAP as free weatherization assistance for qualifying low-income households; the state or local provider determines eligibility and the scope of work.',
    reviewed_at: SOURCE_REVIEWED_AT,
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
      'Official federal benefit path administered by states, territories, and Tribes. Depending on the local program, LIHEAP may weatherize a home or provide minor energy-related repairs, including eligible heating or cooling equipment work.',
    url: 'https://www.acf.hhs.gov/ocs/programs/liheap',
    source_url: 'https://ocsannualreport.acf.hhs.gov/annual-report-fy24/liheap-fact-sheet',
    result_source: 'official_green_home_locator',
    record_origin: 'official_directory',
    opportunity_kind: 'benefit',
    is_pointer: true,
    is_lead: false,
    no_cost_status: 'official_no_cost_path',
    no_cost_evidence:
      'HHS states that LIHEAP can weatherize homes or make minor energy-related home repairs for eligible low-income households. Services and covered measures vary by administering agency.',
    reviewed_at: SOURCE_REVIEWED_AT,
    applicant_types: ['individual', 'family', 'homeowner', 'renter'],
    upgrades: ['weatherization', 'minor energy-related repairs', 'eligible heating or cooling repair or replacement'],
    eligibility_bullets: [
      'Eligibility and covered services vary by state, territory, or Tribe.',
      'Priority commonly includes households with high energy burden, older adults, people with disabilities, or young children.',
      'Use the administering agency to confirm that the specific work is provided without a customer payment.',
      'This path does not authorize a loan, tax credit, reimbursement-only offer, lease, or financing product.',
    ],
  },
])

const GREEN_HOME_PATTERNS = Object.freeze([
  /\bweatheri[sz]ation\b/i,
  /\binsulation\b/i,
  /\bair[- ]?seal(?:ing)?\b/i,
  /\bheat pump\b/i,
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

const POSITIVE_NO_COST_PATTERNS = Object.freeze([
  { pattern: /\bno[- ]cost\b/i, label: 'The source explicitly describes the service as no cost.' },
  { pattern: /\bat no cost\b/i, label: 'The source explicitly states that the service is provided at no cost.' },
  { pattern: /\bfree (?:weatherization|installation|upgrade|repair|service)s?\b/i, label: 'The source explicitly describes free weatherization, installation, upgrades, repairs, or services.' },
  { pattern: /\bfree of charge\b/i, label: 'The source explicitly states that the service is free of charge.' },
  { pattern: /\bzero out[- ]of[- ]pocket\b/i, label: 'The source explicitly states zero out-of-pocket cost.' },
  { pattern: /\b100% (?:covered|funded)\b/i, label: 'The source states that the covered work is fully funded.' },
  { pattern: /\bfully funded\b/i, label: 'The source states that the covered work is fully funded.' },
  { pattern: /\bdirect[- ]install(?:ation)?\b/i, label: 'The source describes a direct-install program rather than a financing offer.' },
  { pattern: /\bprovided (?:free|without charge)\b/i, label: 'The source states that the service is provided without charge.' },
  { pattern: /\bgrant[- ]funded\b/i, label: 'The source describes the covered work as grant funded.' },
  { pattern: /\bdoes not need to be repaid\b/i, label: 'The source states that the assistance does not need to be repaid.' },
  { pattern: /\bno repayment\b/i, label: 'The source explicitly states that repayment is not required.' },
  { pattern: /\bweatherization assistance program\b/i, label: 'The source identifies an official Weatherization Assistance Program path.' },
  { pattern: /\bliheap\b/i, label: 'The source identifies a LIHEAP-administered energy-assistance path.' },
])

const NEGATED_REPAYMENT_PATTERNS = Object.freeze([
  /\bdoes not need to be repaid\b/gi,
  /\bno repayment\b/gi,
  /\bnot a loan\b/gi,
  /\bno loan required\b/gi,
  /\bwithout financing\b/gi,
])

const FORBIDDEN_COST_PATTERNS = Object.freeze([
  { code: 'loan_or_financing', pattern: /\b(?:loan|financing|finance plan|line of credit|credit product|mortgage|property assessed clean energy|pace financing)\b/i },
  { code: 'lease_or_ppa', pattern: /\b(?:lease|leasing|power purchase agreement|solar ppa|\bppa\b)\b/i },
  { code: 'tax_credit', pattern: /\b(?:tax credit|tax deduction|tax incentive)\b/i },
  { code: 'rebate', pattern: /\brebate\b/i },
  { code: 'reimbursement', pattern: /\b(?:reimbursement|reimburse after|post[- ]purchase reimbursement)\b/i },
  { code: 'applicant_payment', pattern: /\b(?:down payment|monthly payment|interest rate|\bapr\b|repayment term|repay the|customer payment|homeowner payment|participant payment)\b/i },
  { code: 'cost_share_or_match', pattern: /\b(?:cost[- ]share|cost sharing|matching funds?|match required|required match|customer contribution|homeowner contribution|applicant contribution|participant contribution|co[- ]?pay|out[- ]of[- ]pocket cost)\b/i },
  { code: 'purchase_required', pattern: /\b(?:purchase required|must purchase|buy first|after purchase|qualifying purchase)\b/i },
])

const RETIRED_PROGRAM_PATTERNS = Object.freeze([
  /\bsolar for all\b/i,
  /\bgreenhouse gas reduction fund\b/i,
])

const VERIFIED_SOURCE_TRUST = new Set([
  'official_api',
  'official_government',
  'official_registry',
  'verified',
  'verified_source',
])

function asText(value) {
  if (value === null || value === undefined) return ''
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
    result.eligibility_bullets,
    result.no_cost_evidence,
  ].map(asText).join(' ').replace(/\s+/g, ' ').trim()
}

function cleanNegatedRepayment(text) {
  return NEGATED_REPAYMENT_PATTERNS.reduce(
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
  const matched = POSITIVE_NO_COST_PATTERNS.find(({ pattern }) => pattern.test(text))
  return matched?.label || null
}

function structuredCostBlock(result = {}) {
  if (result.is_loan === true) return 'loan_or_financing'
  if (result.requires_match === true) return 'cost_share_or_match'
  if (Number(result.match_percentage) > 0) return 'cost_share_or_match'
  if (result.requires_cost_share === true) return 'cost_share_or_match'
  if (result.requires_upfront_payment === true) return 'applicant_payment'
  if (result.reimbursement_only === true) return 'reimbursement'
  if (result.is_tax_credit === true) return 'tax_credit'
  if (result.is_rebate === true) return 'rebate'
  if (result.financing_required === true) return 'loan_or_financing'
  if (result.requires_lease_or_ppa === true) return 'lease_or_ppa'
  if (result.applicant_contribution_required === true) return 'cost_share_or_match'
  return null
}

function sourceTrust(result = {}) {
  const url = result.source_url || result.url || result.application_url || result.info_url
  if (isOfficialGovernmentUrl(url)) return 'official_government'
  if (result.result_source === 'official_green_home_locator') return 'official_government'
  const declared = String(result.source_trust || result.trust_level || '').trim().toLowerCase()
  if (VERIFIED_SOURCE_TRUST.has(declared)) return 'verified_source'
  if (result.result_source === 'catalog' || result.result_source === 'curated') return 'unverified_catalog'
  return 'unverified_web'
}

export function classifyNoCostGreenHomeResult(result = {}) {
  const text = resultText(result)
  if (!hasGreenHomeRelevance(text)) {
    return {
      status: 'excluded',
      reason: 'not_green_home_upgrade',
      policy_version: POLICY_VERSION,
    }
  }

  if (RETIRED_PROGRAM_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      status: 'excluded',
      reason: 'retired_or_rescinded_program',
      policy_version: POLICY_VERSION,
    }
  }

  const structuredBlock = structuredCostBlock(result)
  if (structuredBlock) {
    return {
      status: 'excluded',
      reason: structuredBlock,
      policy_version: POLICY_VERSION,
    }
  }

  const costScanText = cleanNegatedRepayment(text)
  const forbidden = FORBIDDEN_COST_PATTERNS.find(({ pattern }) => pattern.test(costScanText))
  if (forbidden) {
    return {
      status: 'excluded',
      reason: forbidden.code,
      policy_version: POLICY_VERSION,
    }
  }

  const evidence = noCostEvidence(text, result)
  if (!evidence) {
    return {
      status: 'review',
      reason: 'no_cost_not_proven',
      policy_version: POLICY_VERSION,
    }
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

  return {
    status: 'eligible',
    reason: 'explicit_no_cost_no_loan_path',
    no_cost_evidence: evidence,
    source_trust: trust,
    policy_version: POLICY_VERSION,
  }
}

export function officialGreenHomePaths(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now)
  return OFFICIAL_GREEN_HOME_PATHS.map((program) => {
    const reviewed = new Date(`${program.reviewed_at}T00:00:00Z`)
    const ageDays = Number.isFinite(current.getTime()) && Number.isFinite(reviewed.getTime())
      ? Math.floor((current.getTime() - reviewed.getTime()) / 86_400_000)
      : Number.POSITIVE_INFINITY
    const fresh = ageDays >= 0 && ageDays <= SOURCE_MAX_AGE_DAYS
    return {
      ...program,
      source_fresh: fresh,
      source_age_days: Number.isFinite(ageDays) ? ageDays : null,
      no_cost_policy: POLICY_VERSION,
      no_cost_classification: fresh ? 'eligible' : 'review',
      no_cost_reason: fresh ? 'explicit_no_cost_no_loan_path' : 'official_source_review_stale',
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
