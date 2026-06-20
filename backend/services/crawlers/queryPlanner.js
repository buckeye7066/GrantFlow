import { buildIntentTokens } from '../profile/profileTaxonomy.js'
const INTENT_MUST_NOT_CONFIDENCE_THRESHOLD = 0.7

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
  // ── Student-aid coverage: federal portals + major trusted aggregators ──
  'fafsa.gov',
  'collegescorecard.ed.gov',
  'fastweb.com',
  'scholarships.com',
  'careeronestop.org',
  'finaid.org',
  'salliemae.com', // ScholarshipSearch directory (no-loan content)
  // ── State higher-education agencies (the canonical state student-aid orgs) ──
  'tn.gov/collegepays', // TSAC / Tennessee Student Assistance Corporation
  'collegepays.org',    // TSAC public portal (TN HOPE / TSAA / Promise / Reconnect)
  'tnreconnect.gov',
  'cfwv.com',           // West Virginia HEPC OneApp
  'csac.ca.gov',        // California Student Aid Commission (Cal Grant)
  'hesc.ny.gov',        // NY Higher Education Services Corp (TAP / Excelsior)
  'isac.org',           // Illinois Student Assistance Commission (MAP)
  'gafutures.org',      // Georgia (HOPE / Zell Miller)
  'floridastudentfinancialaidsg.org', // FL OSFA (Bright Futures)
  'highered.ohio.gov',  // Ohio (OCOG / Choose Ohio First)
  'pheaa.org',          // Pennsylvania (state grant)
  // ── Community / place-based funders (local→national, trusted directories) ──
  'cof.org',            // Council on Foundations (community-foundation locator)
  'candid.org',         // Foundation Directory / GrantSpace
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

// State student-aid program names by USPS code. Surfaced as shouldTerms in the
// student_grants plan so a state-resident student gets their own state's awards
// without typing the acronyms. Kept in step with STATE_STUDENT_AID in
// profileHelpers.js (the keyword-tagging counterpart).
const STATE_STUDENT_AID_TERMS = {
  TN: ['tennessee hope scholarship', 'tennessee promise', 'tennessee student assistance award', 'tsaa', 'step up scholarship', 'hope aspire award', 'tennessee reconnect'],
  WV: ['wv promise scholarship', 'wv invests', 'higher education grant', 'cfwv oneapp'],
  CA: ['cal grant', 'middle class scholarship', 'chafee grant'],
  NY: ['tap grant', 'tuition assistance program', 'excelsior scholarship'],
  IL: ['map grant', 'monetary award program'],
  TX: ['toward excellence access success grant', 'teach grant texas'],
  GA: ['georgia hope scholarship', 'zell miller scholarship', 'hope grant'],
  FL: ['bright futures scholarship', 'florida student assistance grant'],
  OH: ['ohio college opportunity grant', 'choose ohio first'],
  PA: ['pheaa state grant', 'ready to succeed scholarship'],
  NC: ['nc need based scholarship', 'nc community college grant'],
  MI: ['michigan competitive scholarship', 'tuition incentive program'],
  KY: ['kentucky educational excellence scholarship', 'kees', 'cap grant'],
  AL: ['alabama student assistance program', 'asap grant'],
  VA: ['virginia tuition assistance grant', 'vtag'],
  SC: ['palmetto fellows scholarship', 'life scholarship', 'south carolina need based grant'],
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

function normalizeConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  if (number <= 0) return 0
  if (number >= 1) return 1
  return number
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
  if (hasAnyToken(seeds, ['veteran', 'military'])) terms.push('veteran assistance')
  if (hasAnyToken(seeds, ['caregiver'])) terms.push('caregiver support program')
  if (hasAnyToken(seeds, ['disabled', 'disability'])) terms.push('disability grant')
  if (hasAnyToken(seeds, ['emergency', 'crisis'])) terms.push('emergency assistance program')
  if (hasAnyToken(seeds, ['senior', 'elderly', 'older_adult'])) terms.push('senior assistance program')
  if (hasAnyToken(seeds, ['individual', 'person'])) terms.push('individual grant')
  return uniqueStrings(terms)
}

function intentDisambiguation({ facets, mustTerms, shouldTerms, mustNotTerms, requiredConcepts, allowAggressiveMustNot }) {
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
    if (allowAggressiveMustNot) {
      mustNotTerms.push('food bank')
      mustNotTerms.push('food pantry')
      mustNotTerms.push('hunger relief')
    }
    requiredConcepts.push('business funding')
  }

  // 1b) Food security (food bank / pantry) vs restaurant startup noise.
  const isFoodSecurityIntent =
    intentCategory === 'food_security' ||
    hasAnyToken(intentKeywords, ['food pantry', 'food bank', 'nutrition support', 'hunger'])
  if (isFoodSecurityIntent && !isFoodTruckIntent) {
    shouldTerms.push('food assistance')
    shouldTerms.push('food pantry near me')
    shouldTerms.push('hunger relief program')
    if (allowAggressiveMustNot) {
      mustNotTerms.push('food truck startup')
      mustNotTerms.push('restaurant franchise')
      mustNotTerms.push('catering business')
    }
  }

  // 2) Strike assistance (workers in active labor strikes).
  if (hasAnyToken(intentKeywords, ['strike', 'walkout', 'labor dispute', 'union hardship'])) {
    shouldTerms.push('strike hardship fund')
    shouldTerms.push('union emergency assistance')
    shouldTerms.push('labor relief grant')
    if (allowAggressiveMustNot) mustNotTerms.push('stock option strike price')
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
    if (allowAggressiveMustNot) mustNotTerms.push('teacher certification loan')
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

const SECTION_RELEVANCE = {
  comprehensive:      { financial: 0.7, health: 0.6, demographics: 0.6, education: 0.6, military: 0.7, family: 0.5, assistance: 0.7, organization: 0.6 },
  government_funding: { financial: 1.0, organization: 1.0, demographics: 0.5, military: 0.7, education: 0.5, assistance: 0.8, health: 0.3, family: 0.3 },
  local_funding:      { financial: 0.8, family: 0.8, demographics: 0.7, assistance: 0.9, health: 0.5, education: 0.3, military: 0.5, organization: 0.5 },
  student_grants:     { education: 1.0, financial: 0.9, demographics: 0.8, military: 0.6, family: 0.5, health: 0.3, assistance: 0.3, organization: 0.0 },
  health_resources:   { health: 1.0, assistance: 0.9, financial: 0.7, demographics: 0.5, family: 0.5, military: 0.3, education: 0.0, organization: 0.3 },
  special_needs:      { health: 1.0, assistance: 1.0, family: 0.7, financial: 0.7, demographics: 0.5, military: 0.3, education: 0.0, organization: 0.3 },
  item_matching:      { health: 0.6, financial: 0.8, family: 0.5, assistance: 0.7, demographics: 0.4, military: 0.5, education: 0.3, organization: 0.5 },
  ecf_benefits:       { assistance: 1.0, health: 0.9, family: 0.8, financial: 0.7, demographics: 0.5, military: 0.3, education: 0.0, organization: 0.0 },
}

function profileSignalTerms(facets = {}, crawlerType = 'comprehensive') {
  const weights = SECTION_RELEVANCE[crawlerType] ?? SECTION_RELEVANCE.comprehensive
  const mustTerms = []
  const shouldTerms = []

  function addIf(weight, term) {
    if (!term) return
    if (weight >= 0.8) mustTerms.push(term)
    else if (weight >= 0.3) shouldTerms.push(term)
  }

  const fin = facets?.financial ?? {}
  const finW = weights.financial ?? 0.3
  if (fin.annual_income_bracket) addIf(finW, `${fin.annual_income_bracket} income assistance`)
  if (fin.below_poverty_line) addIf(finW, 'low income grant')
  if (fin.annual_budget) addIf(Math.min(finW, 0.5), 'organizational funding')

  const health = facets?.health ?? {}
  const healthW = weights.health ?? 0.3
  const conditions = Array.isArray(health.conditions) ? health.conditions : []
  for (const c of conditions.slice(0, 4)) {
    addIf(healthW, `${normalizeString(c)} patient assistance`)
  }
  const disabilities = Array.isArray(health.disability_types) ? health.disability_types : []
  for (const d of disabilities.slice(0, 3)) {
    addIf(healthW, `${normalizeString(d)} disability support`)
  }

  const demo = facets?.demographics ?? {}
  const demoW = weights.demographics ?? 0.3
  if (demo.veteran === true || demo.is_veteran === true) addIf(Math.max(demoW, 0.7), 'veteran grant')
  if (demo.age_bracket === 'senior' || demo.age >= 65) addIf(demoW, 'senior assistance program')
  if (demo.age_bracket === 'youth' || (demo.age && demo.age < 25)) addIf(demoW, 'youth grant')
  if (demo.race_ethnicity && typeof demo.race_ethnicity === 'string') {
    addIf(Math.min(demoW, 0.5), `${normalizeString(demo.race_ethnicity)} scholarship`)
  }
  if (demo.gender === 'female' || demo.gender === 'woman') addIf(Math.min(demoW, 0.5), 'women grant program')
  if (demo.first_generation) addIf(demoW, 'first generation student')

  const edu = facets?.education ?? {}
  const eduW = weights.education ?? 0.3
  if (edu.education_level) addIf(eduW, `${normalizeString(edu.education_level)} education assistance`)
  if (edu.field_of_study) addIf(eduW, `${normalizeString(edu.field_of_study)} scholarship`)
  if (edu.institution_type === 'hbcu') addIf(eduW, 'HBCU scholarship')
  if (edu.institution_type === 'community_college') addIf(eduW, 'community college grant')
  if (edu.gpa && Number(edu.gpa) >= 3.5) addIf(Math.min(eduW, 0.5), 'merit scholarship')

  const mil = facets?.military ?? {}
  const milW = weights.military ?? 0.3
  if (mil.is_veteran || mil.service_branch) addIf(milW, 'veteran benefits')
  if (mil.service_branch) addIf(milW, `${normalizeString(mil.service_branch)} veteran assistance`)
  if (mil.is_active_duty) addIf(milW, 'active duty military support')
  if (mil.combat_veteran) addIf(milW, 'combat veteran grant')
  if (mil.military_spouse) addIf(milW, 'military spouse assistance')

  const fam = facets?.family ?? {}
  const famW = weights.family ?? 0.3
  if (fam.single_parent) addIf(famW, 'single parent assistance')
  if (fam.household_size && Number(fam.household_size) >= 5) addIf(famW, 'large family support')
  if (fam.has_dependents_with_disability) addIf(famW, 'family disability support')
  if (fam.foster_care || fam.aging_out_foster) addIf(Math.max(famW, 0.7), 'foster youth grant')

  const assist = facets?.assistance ?? {}
  const assistW = weights.assistance ?? 0.3
  if (assist.receives_snap || assist.snap || assist.snap_recipient) {
    addIf(assistW, 'SNAP recipient benefits')
    addIf(assistW, 'food assistance')
  }
  if (assist.receives_ssi || assist.ssi) addIf(assistW, 'SSI recipient programs')
  if (assist.receives_ssdi || assist.ssdi) addIf(assistW, 'SSDI recipient assistance')
  if (assist.receives_tanf || assist.tanf) addIf(assistW, 'TANF additional benefits')
  if (assist.medicaid) addIf(assistW, 'medicaid enrollee programs')
  if (assist.section_8 || assist.housing_voucher) addIf(assistW, 'housing voucher holder programs')

  const org = facets?.organization ?? {}
  const orgW = weights.organization ?? 0.3
  if (org.organization_type === 'nonprofit' || org.nonprofit_ready) addIf(orgW, 'nonprofit grant')
  if (org.organization_type === 'church' || org.organization_type === 'faith_based') addIf(orgW, 'faith based organization grant')
  if (org.organization_type === 'school') addIf(orgW, 'school district grant')

  // Immigration status
  const immigration = facets?.immigration ?? {}
  if (immigration.refugee || immigration.is_refugee) addIf(0.8, 'refugee resettlement assistance')
  if (immigration.new_immigrant || immigration.immigrant_status === 'new_immigrant' || immigration.is_immigrant) addIf(0.7, 'immigrant assistance program')
  if (immigration.permanent_resident || immigration.is_permanent_resident) addIf(0.5, 'permanent resident benefits')

  // Geographic qualifiers
  const geo = (typeof facets?.geographic === 'object' && facets.geographic !== null)
    ? facets.geographic
    : {}
  if (geo.rural_resident || geo.rural) addIf(0.7, 'rural community grant')
  if (geo.appalachian_region || geo.appalachian) addIf(0.7, 'appalachian community program')
  if (geo.urban_underserved) addIf(0.6, 'urban underserved assistance')
  if (geo.tribal_land) addIf(0.7, 'tribal community grant')

  // Occupation-specific (beyond teacher/nurse handled by intentDisambiguation)
  const occFacet = facets?.occupation ?? {}
  if (occFacet.farmer) addIf(0.7, 'farmer grant USDA')
  if (occFacet.firefighter) addIf(0.6, 'firefighter assistance program')
  if (occFacet.law_enforcement) addIf(0.6, 'law enforcement grant')
  if (occFacet.clergy || occFacet.missionary) addIf(0.5, 'faith worker assistance')
  if (occFacet.truck_driver) addIf(0.5, 'CDL driver assistance program')

  // Family situations not yet covered
  if (fam.homeless) addIf(0.8, 'homeless shelter assistance')
  if (fam.formerly_incarcerated) addIf(0.8, 'reentry program formerly incarcerated')
  if (fam.domestic_violence_survivor) addIf(0.8, 'domestic violence survivor assistance')
  if (fam.trafficking_survivor) addIf(0.8, 'trafficking survivor services')
  if (fam.caregiver) addIf(famW, 'family caregiver support program')
  if (fam.grandparent_raising_grandchildren) addIf(famW, 'grandparent kinship care assistance')
  if (fam.disaster_survivor) addIf(0.7, 'disaster relief assistance')

  return {
    mustTerms: uniqueStrings(mustTerms).slice(0, 20),
    shouldTerms: uniqueStrings(shouldTerms).slice(0, 40),
  }
}

export { profileSignalTerms }

export function planCrawlerQueries({ crawlerType, facets = {}, location = null }) {
  const normalizedCrawlerType = normalizeString(crawlerType || 'comprehensive') || 'comprehensive'
  const intentConfidence = normalizeConfidence(facets?.intent?.confidence)
  const allowAggressiveMustNot = intentConfidence >= INTENT_MUST_NOT_CONFIDENCE_THRESHOLD
  const effectiveLocation = location || facets?.geo || {}
  const intentTokens = (typeof buildIntentTokens === 'function') ? buildIntentTokens({ facets }) : { mustTerms: [], shouldTerms: [], mustNotTerms: [] }

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

  const signalTerms = profileSignalTerms(facets, normalizedCrawlerType)
  mustTerms.push(...signalTerms.mustTerms)
  shouldTerms.push(...signalTerms.shouldTerms)

  // Crawler-specific baselines.
  if (normalizedCrawlerType === 'student_grants') {
    mustTerms.push('scholarship')
    shouldTerms.push('financial aid')
    shouldTerms.push('tuition assistance')
    shouldTerms.push('pell grant')
    shouldTerms.push('fafsa')
    // State-specific student-aid program NAMES so the right state awards surface
    // even before the student types the acronyms. Mirrors the STATE_STUDENT_AID
    // map in profileHelpers (keeps the two in step for a relatable, state-aware
    // student crawl). Missing/unknown state simply adds nothing — neutral.
    const studentState = normalizeString(effectiveLocation?.state || '').toUpperCase()
    const stateAid = STATE_STUDENT_AID_TERMS[studentState]
    if (stateAid) shouldTerms.push(...stateAid)
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
    const userState = normalizeString(effectiveLocation?.state || '').toUpperCase()
    if (!userState || userState === 'TN') {
      preferredSponsors.push('TennCare', 'Tennessee DIDD')
    }
    dedupeKeys.push('benefit_categories')
  }

  intentDisambiguation({
    facets,
    mustTerms,
    shouldTerms,
    mustNotTerms,
    requiredConcepts,
    allowAggressiveMustNot,
  })

  // Geographic expansion hint: city -> county -> state -> national.
  if (effectiveLocation?.city) requiredConcepts.push('city_or_county_match')
  else if (effectiveLocation?.county) requiredConcepts.push('county_or_state_match')
  else if (effectiveLocation?.state) requiredConcepts.push('state_or_national_match')
  else requiredConcepts.push('national_match')

  return {
    mustTerms: uniqueStrings(mustTerms).slice(0, 32),
    shouldTerms: uniqueStrings(shouldTerms).slice(0, 60),
    mustNotTerms: uniqueStrings(mustNotTerms).slice(0, 32),
    preferredSponsors: uniqueStrings(preferredSponsors).slice(0, 24),
    authorityDomainsAllowlist: uniqueStrings(authorityDomainsAllowlist),
    authorityDomainsBlocklist: uniqueStrings(authorityDomainsBlocklist),
    requiredConcepts: uniqueStrings(requiredConcepts).slice(0, 24),
    dedupeKeys: uniqueStrings(dedupeKeys),
  }
}

export default { planCrawlerQueries, profileSignalTerms, SECTION_RELEVANCE }
