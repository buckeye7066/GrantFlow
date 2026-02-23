import { buildIntentTokens } from '../profile/profileTaxonomy.js'

const AUTHORITY_ALLOWLIST_BASE = [
  'grants.gov',
  'usa.gov',
  'benefits.gov',
  'sba.gov',
  'hud.gov',
  'usda.gov',
  'nih.gov',
  'cms.gov',
  'medicaid.gov',
  'acl.gov',
  'dol.gov',
  'ed.gov',
  'va.gov',
  'state.gov',
  'tn.gov',
  'ca.gov',
  'ny.gov',
  'ohio.gov',
  'oregon.gov',
  'michigan.gov',
  'unitedway.org',
  'feedingamerica.org',
  'communityactionpartnership.com',
  'cancer.org',
  'needymeds.org',
  'nami.org',
  'studentaid.gov',
  'collegeboard.org',
  'questbridge.org',
  'hsf.net',
  'uncf.org',
  'tmcf.org',
  'foldsofhonor.org',
  'pattillmanfoundation.org',
]

const AUTHORITY_BLOCKLIST_BASE = [
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'youtube.com',
  'reddit.com',
  'pinterest.com',
  'wikipedia.org',
  'quora.com',
  'medium.com',
  'blogspot.com',
  'wordpress.com',
  'yelp.com',
  'amazon.com',
  'ebay.com',
  'walmart.com',
]

const CRAWLER_REQUIRED_CONCEPTS = {
  comprehensive: ['grant'],
  local_funding: ['local support', 'community resources'],
  government_funding: ['federal grant', 'state grant'],
  student_grants: ['scholarship', 'student aid'],
  health_resources: ['health assistance', 'patient support'],
  special_needs: ['specialized support'],
  item_matching: ['equipment', 'item support'],
  ecf_benefits: ['medicaid waiver', 'community-based support'],
}

const CRAWLER_PREFERRED_SPONSORS = {
  government_funding: ['U.S. Department of Education', 'HUD', 'USDA', 'HHS', 'NIH', 'CMS'],
  student_grants: ['U.S. Department of Education', 'UNCF', 'QuestBridge', 'HSF'],
  health_resources: ['NIH', 'CDC', 'Medicaid.gov', 'Patient Advocate Foundation'],
  special_needs: ['American Cancer Society', 'NAMI', 'DAV', 'Easterseals'],
  local_funding: ['United Way', 'Feeding America', 'Community Action Partnership'],
  ecf_benefits: ['TennCare', 'Tennessee DIDD', 'Administration for Community Living'],
}

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function uniqueStrings(values = []) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const normalized = normalizeString(String(value || ''))
    if (!normalized) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function hasAnyToken(haystack = [], needles = []) {
  const items = uniqueStrings(haystack)
  return needles.some((needle) => {
    const n = normalizeString(needle)
    if (!n) return false
    return items.some((item) => item.includes(n) || n.includes(item))
  })
}

function stateAnalogTerms(stateCode) {
  const state = normalizeString(stateCode).toUpperCase()
  const analogs = {
    TN: ['ecf choices', 'employment and community first', 'didd services'],
    OH: ['ohio medicaid waiver', 'home and community based waiver', 'self-directed services'],
    CA: ['in-home supportive services', 'regional center waiver', 'hcbs california'],
    NY: ['nhtd waiver', 'opwdd supports', 'consumer directed personal assistance'],
    OR: ['odds services', 'k plan supports', 'oregon hcbs waiver'],
  }
  return analogs[state] ?? ['medicaid waiver', 'home and community based services']
}

function geoTerms(location = {}) {
  const terms = []
  const state = normalizeString(location?.state || '').toUpperCase()
  const city = normalizeString(location?.city || '')
  const county = normalizeString(location?.county || '')
  const zip = normalizeString(location?.zip || '')

  if (state) {
    terms.push(`${state} grant`)
    terms.push(`${state} assistance program`)
  }
  if (city) {
    terms.push(`${city} local grant`)
    terms.push(`${city} community assistance`)
  }
  if (county) {
    terms.push(`${county} county program`)
  }
  if (zip) {
    terms.push(`zip ${zip} resources`)
  }
  return uniqueStrings(terms)
}

function applicantTerms(facets = {}) {
  const primary = normalizeString(facets?.profile?.primary_profile_type || '')
  const applicantTypes = Array.isArray(facets?.profile?.applicant_types)
    ? facets.profile.applicant_types
    : []
  const seeds = [primary, ...applicantTypes]
  const terms = []
  if (hasAnyToken(seeds, ['student'])) terms.push('student')
  if (hasAnyToken(seeds, ['nonprofit', 'organization'])) terms.push('nonprofit')
  if (hasAnyToken(seeds, ['small_business', 'business'])) terms.push('small business')
  if (hasAnyToken(seeds, ['family'])) terms.push('family support')
  if (hasAnyToken(seeds, ['medical_assistance', 'medical'])) terms.push('medical assistance')
  return uniqueStrings(terms)
}

function intentDisambiguation({ facets, mustTerms, shouldTerms, mustNotTerms, requiredConcepts }) {
  const intentKeywords = Array.isArray(facets?.intent?.keywords) ? facets.intent.keywords : []
  const intentCategory = normalizeString(facets?.intent?.primary_need_category || '')
  const occupation = facets?.occupation ?? {}
  const assistance = facets?.assistance ?? {}

  // 1) Food truck business vs food bank assistance.
  const isFoodTruckIntent =
    intentCategory === 'business_startup' &&
    hasAnyToken(intentKeywords, ['food truck', 'mobile food', 'food vendor', 'catering'])
  if (isFoodTruckIntent) {
    mustTerms.push('food truck grant')
    shouldTerms.push('mobile food business')
    shouldTerms.push('small business startup')
    mustNotTerms.push('food bank')
    mustNotTerms.push('food pantry')
    mustNotTerms.push('hunger relief')
    requiredConcepts.push('business funding')
  }

  // 2) Strike assistance (workers in active labor strikes).
  if (hasAnyToken(intentKeywords, ['strike', 'walkout', 'labor dispute', 'union hardship'])) {
    shouldTerms.push('strike hardship fund')
    shouldTerms.push('union emergency assistance')
    shouldTerms.push('labor relief grant')
    mustNotTerms.push('stock option strike price')
    requiredConcepts.push('worker emergency assistance')
  }

  // 3) Teacher classroom supplies.
  const teacherNeedsSupplies =
    occupation.educator === true &&
    hasAnyToken(intentKeywords, ['classroom', 'school supplies', 'teacher supplies', 'curriculum'])
  if (teacherNeedsSupplies) {
    shouldTerms.push('teacher classroom grant')
    shouldTerms.push('school supplies stipend')
    shouldTerms.push('educator mini grant')
    mustNotTerms.push('teacher certification loan')
    requiredConcepts.push('classroom supplies')
  }

  // 4) Nurse licensure/training.
  const nurseLicensureIntent =
    occupation.healthcare_worker === true &&
    hasAnyToken(intentKeywords, ['nurse', 'nursing', 'nclex', 'licensure', 'license', 'certification'])
  if (nurseLicensureIntent) {
    shouldTerms.push('nursing scholarship')
    shouldTerms.push('nclex prep assistance')
    shouldTerms.push('nurse licensure training grant')
    requiredConcepts.push('workforce training')
  }

  // 5) ECF and state analogs.
  const hasEcfSignals =
    normalizeString(assistance?.medicaid_waiver_program || '') === 'ecf_choices' ||
    normalizeString(assistance?.ecf_choices_role || '').length > 0 ||
    hasAnyToken(intentKeywords, ['ecf choices', 'community first'])
  if (hasEcfSignals) {
    shouldTerms.push('employment and community first choices')
    shouldTerms.push('home and community based services')
    requiredConcepts.push('medicaid waiver')
  }
}

export function planCrawlerQueries({ crawlerType, facets = {}, location = null }) {
  const normalizedCrawlerType = normalizeString(crawlerType || 'comprehensive') || 'comprehensive'
  const effectiveLocation = location || facets?.geo || {}
  const intentTokens = buildIntentTokens({ facets })

  const mustTerms = [...(intentTokens?.mustTerms || [])]
  const shouldTerms = [...(intentTokens?.shouldTerms || [])]
  const mustNotTerms = [...(intentTokens?.mustNotTerms || [])]
  const preferredSponsors = [...(CRAWLER_PREFERRED_SPONSORS[normalizedCrawlerType] || [])]
  const authorityDomainsAllowlist = [...AUTHORITY_ALLOWLIST_BASE]
  const authorityDomainsBlocklist = [...AUTHORITY_BLOCKLIST_BASE]
  const requiredConcepts = [...(CRAWLER_REQUIRED_CONCEPTS[normalizedCrawlerType] || ['grant'])]
  const dedupeKeys = ['source_url', 'application_url', 'url', 'title', 'sponsor']

  shouldTerms.push(...geoTerms(effectiveLocation))
  shouldTerms.push(...applicantTerms(facets))

  // Crawler-specific baselines.
  if (normalizedCrawlerType === 'student_grants') {
    mustTerms.push('scholarship')
    shouldTerms.push('financial aid')
    shouldTerms.push('tuition assistance')
    dedupeKeys.push('opportunity_number')
  }
  if (normalizedCrawlerType === 'government_funding') {
    shouldTerms.push('federal grant')
    shouldTerms.push('state grant')
    shouldTerms.push('agency notice')
    dedupeKeys.push('source_id')
  }
  if (normalizedCrawlerType === 'local_funding') {
    shouldTerms.push('community foundation')
    shouldTerms.push('local assistance')
    shouldTerms.push('county resources')
  }
  if (normalizedCrawlerType === 'health_resources') {
    shouldTerms.push('patient support')
    shouldTerms.push('care coordination')
  }
  if (normalizedCrawlerType === 'special_needs') {
    shouldTerms.push('disability assistance')
    shouldTerms.push('specialized support')
  }
  if (normalizedCrawlerType === 'item_matching') {
    shouldTerms.push('equipment assistance')
    shouldTerms.push('item donation program')
  }
  if (normalizedCrawlerType === 'ecf_benefits') {
    mustTerms.push('medicaid waiver')
    shouldTerms.push('community based support')
    const stateTerms = stateAnalogTerms(effectiveLocation?.state || '')
    shouldTerms.push(...stateTerms)
    preferredSponsors.push('TennCare', 'Tennessee DIDD')
    dedupeKeys.push('benefit_categories')
  }

  intentDisambiguation({ facets, mustTerms, shouldTerms, mustNotTerms, requiredConcepts })

  // Geographic expansion hint: city -> county -> state -> national.
  if (effectiveLocation?.city) requiredConcepts.push('city_or_county_match')
  else if (effectiveLocation?.county) requiredConcepts.push('county_or_state_match')
  else if (effectiveLocation?.state) requiredConcepts.push('state_or_national_match')
  else requiredConcepts.push('national_match')

  return {
    mustTerms: uniqueStrings(mustTerms).slice(0, 24),
    shouldTerms: uniqueStrings(shouldTerms).slice(0, 48),
    mustNotTerms: uniqueStrings(mustNotTerms).slice(0, 32),
    preferredSponsors: uniqueStrings(preferredSponsors).slice(0, 24),
    authorityDomainsAllowlist: uniqueStrings(authorityDomainsAllowlist),
    authorityDomainsBlocklist: uniqueStrings(authorityDomainsBlocklist),
    requiredConcepts: uniqueStrings(requiredConcepts).slice(0, 24),
    dedupeKeys: uniqueStrings(dedupeKeys),
  }
}

export default { planCrawlerQueries }
