/**
 * profileNeedsInterpreter
 * -----------------------
 * Turns a profile + its sections into a structured needs document the rest
 * of the system (Anya Match Scout, Anya chat, Discover Grants, printable
 * next-steps, admin analytics, profile completion prompts) can consume.
 *
 * Pure, deterministic, no AI/network. Given the same input it produces the
 * same output — so the Match Scout's idempotency key stays stable and
 * tests stay simple.
 *
 * Shape (intentionally aligned with the spec the user provided):
 *
 *   {
 *     primaryNeeds: [
 *       {
 *         key: 'housing_stability',
 *         plainEnglish: 'housing stability or rent help',
 *         searchTerms: ['housing assistance', 'rent relief', ...],
 *         grantflowSearch: {
 *           route: 'DiscoverGrants',
 *           filters: {
 *             category: 'housing',
 *             minScore: DEFAULT_MIN_SCORE,
 *             score_scale_id: SCORE_SCALE_ID
 *           }
 *         },
 *         evidence: ['housing section present', 'tag:rent_help', ...]
 *       },
 *       ...
 *     ],
 *     suggestedSearches: [...],
 *     missingProfileDetails: [...]
 *   }
 *
 * Inputs:
 *   - `profile`  — raw `profiles` row (display_name, primary_type, tags,
 *                  organization_id, state, zip, etc.)
 *   - `sections` — `{ [section_key]: parsedJsonData }`
 *                  Matches the shape returned by
 *                  backend/services/profileHelpers.js#loadProfileContext.
 *   - `signals`  — optional pre-computed signals (unused today, future-proof)
 */

import { safeParseJSON } from '../utils/safeJson.js'
import { DEFAULT_MIN_SCORE, SCORE_SCALE_ID } from '../config/matchThresholds.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toLowerStr(v) {
  return typeof v === 'string' ? v.toLowerCase() : ''
}

function asArray(value) {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    // tags can be CSV strings in legacy rows
    return value
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [value]
}

function tagSet(profile, sections) {
  const set = new Set()
  for (const t of asArray(profile?.tags)) set.add(String(t).toLowerCase())
  // narrative / programs_services tags often live nested
  const programsTags = asArray(sections?.programs_services?.tags)
  for (const t of programsTags) set.add(String(t).toLowerCase())
  const lookingFor = asArray(sections?.basic_information?.looking_for)
  for (const t of lookingFor) set.add(String(t).toLowerCase())
  return set
}

function flatTextOfSection(value) {
  // Defensive: section data can be deeply nested. We collapse strings only.
  if (!value) return ''
  if (typeof value === 'string') return value.toLowerCase()
  if (Array.isArray(value)) return value.map(flatTextOfSection).join(' ')
  if (typeof value === 'object') {
    return Object.values(value).map(flatTextOfSection).join(' ')
  }
  return ''
}

function buildHaystack(profile, sections) {
  return [
    toLowerStr(profile?.display_name),
    toLowerStr(profile?.primary_type),
    toLowerStr(profile?.organization_name),
    toLowerStr(profile?.notes),
    ...asArray(profile?.tags).map(toLowerStr),
    flatTextOfSection(sections?.narrative),
    flatTextOfSection(sections?.programs_services),
    flatTextOfSection(sections?.basic_information),
  ]
    .filter(Boolean)
    .join(' ')
}

function pushNeed(needs, def, evidence) {
  if (!def || !def.key) return
  const existing = needs.find((n) => n.key === def.key)
  if (existing) {
    if (evidence) {
      existing.evidence = Array.from(new Set([...(existing.evidence || []), evidence]))
    }
    return
  }
  needs.push({ ...def, evidence: evidence ? [evidence] : [] })
}

function discoveryFilters(overrides = {}) {
  return {
    ...overrides,
    minScore: DEFAULT_MIN_SCORE,
    score_scale_id: SCORE_SCALE_ID,
  }
}

// ---------------------------------------------------------------------------
// Need catalog
// ---------------------------------------------------------------------------
// Each entry describes a single concrete user need. Detection runs in
// `interpretProfileNeeds()` and pushes one or more of these into the
// `primaryNeeds` array based on the evidence.
//
// `searchTerms` should be SHORT, plain-English phrases — they get rendered
// inline in user prompts ("Try searching for: housing assistance, rent
// relief, ..."). Avoid acronyms.

const NEED_HOUSING = {
  key: 'housing_stability',
  plainEnglish: 'housing stability or rent help',
  searchTerms: [
    'housing assistance',
    'rent relief',
    'homelessness prevention',
    'utility assistance',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ category: 'housing' }),
  },
}

const NEED_HEALTH = {
  key: 'health_medical',
  plainEnglish: 'medical, health, or insurance help',
  searchTerms: [
    'medical bill assistance',
    'prescription help',
    'patient assistance program',
    'charity care',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ category: 'medical' }),
  },
}

const NEED_DISABILITY = {
  key: 'disability_support',
  plainEnglish: 'disability-related support or services',
  searchTerms: [
    'disability transportation assistance',
    'home modification grants',
    'assistive technology funding',
    'special needs services',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ category: 'disability' }),
  },
}

const NEED_STUDENT = {
  key: 'student_aid',
  plainEnglish: 'student aid for school costs',
  searchTerms: [
    'emergency student aid',
    'bridge funding for students',
    'state scholarship programs',
    'off-campus living assistance',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ category: 'education' }),
  },
}

const NEED_EMPLOYMENT = {
  key: 'employment_workforce',
  plainEnglish: 'employment, training, or workforce help',
  searchTerms: [
    'workforce training grants',
    'job placement assistance',
    'WIOA funding',
    'apprenticeship programs',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ category: 'employment' }),
  },
}

const NEED_BUSINESS = {
  key: 'small_business',
  plainEnglish: 'small-business funding or capital',
  searchTerms: [
    'small business grants',
    'minority business funding',
    'SBA programs',
    'rural business assistance',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ category: 'business' }),
  },
}

const NEED_NONPROFIT = {
  key: 'nonprofit_capacity',
  plainEnglish: 'nonprofit, ministry, or church capacity-building',
  searchTerms: [
    'capacity building grants',
    'food pantry funding',
    'faith-based community grants',
    'nonprofit operating support',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ category: 'nonprofit' }),
  },
}

const NEED_FAMILY = {
  key: 'family_support',
  plainEnglish: 'family, children, or caregiving support',
  searchTerms: [
    'family assistance programs',
    'child care subsidy',
    'caregiver grants',
    'parenting support',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ category: 'family' }),
  },
}

const NEED_MILITARY = {
  key: 'military_veteran',
  plainEnglish: 'military, veteran, or surviving-family support',
  searchTerms: [
    'veteran assistance',
    'military family grants',
    'gold star family programs',
    'VA benefits',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ category: 'military' }),
  },
}

const NEED_EMERGENCY = {
  key: 'urgent_emergency',
  plainEnglish: 'urgent help right now',
  searchTerms: [
    'county emergency assistance',
    'utility assistance',
    'rent relief',
    '211 community resources',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ urgent: true }),
  },
}

const NEED_LOCAL = {
  key: 'local_state_programs',
  plainEnglish: 'local and state programs in your area',
  searchTerms: [
    'state assistance programs',
    'county grants',
    'community foundation',
    'local nonprofit support',
  ],
  grantflowSearch: {
    route: 'DiscoverGrants',
    filters: discoveryFilters({ geography_first: true }),
  },
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function detectHousing(needs, profile, sections, tags, haystack) {
  if (sections?.housing && Object.keys(sections.housing).length > 0) {
    pushNeed(needs, NEED_HOUSING, 'housing section present')
  }
  for (const t of ['housing', 'rent_help', 'homeless', 'eviction', 'utilities']) {
    if (tags.has(t)) pushNeed(needs, NEED_HOUSING, `tag:${t}`)
  }
  if (/\b(rent|eviction|homeless|housing|utilit(y|ies))\b/.test(haystack)) {
    pushNeed(needs, NEED_HOUSING, 'narrative mentions housing/rent')
  }
}

function detectHealth(needs, profile, sections, tags, haystack) {
  const has = (k) => sections?.[k] && Object.keys(sections[k]).length > 0
  if (has('health_medical') || has('medical_insurance') || has('medical_history')) {
    pushNeed(needs, NEED_HEALTH, 'health/medical section present')
  }
  for (const t of ['medical', 'health', 'uninsured', 'prescription', 'rare_disease']) {
    if (tags.has(t)) pushNeed(needs, NEED_HEALTH, `tag:${t}`)
  }
  if (/\b(medical|hospital|prescription|insurance|chronic|cancer|diabetes)\b/.test(haystack)) {
    pushNeed(needs, NEED_HEALTH, 'narrative mentions medical/insurance')
  }
}

function detectDisability(needs, profile, sections, tags, haystack) {
  const looking = asArray(sections?.basic_information?.looking_for).map(toLowerStr)
  if (looking.includes('disability')) {
    pushNeed(needs, NEED_DISABILITY, 'looking_for=disability')
  }
  for (const t of ['disability', 'special_needs', 'autism', 'mobility', 'ecf_choices']) {
    if (tags.has(t)) pushNeed(needs, NEED_DISABILITY, `tag:${t}`)
  }
  if (/\b(disability|wheelchair|autism|adhd|sensory|developmental)\b/.test(haystack)) {
    pushNeed(needs, NEED_DISABILITY, 'narrative mentions disability')
  }
  // ECF CHOICES is a Tennessee Medicaid waiver — strong disability signal.
  const govAssist = sections?.government_assistance || {}
  if (toLowerStr(govAssist.medicaid_waiver_program).includes('ecf_choices')) {
    pushNeed(needs, NEED_DISABILITY, 'medicaid_waiver_program=ecf_choices')
  }
}

function detectStudent(needs, profile, sections, tags, haystack) {
  if (toLowerStr(profile?.primary_type).includes('student')) {
    pushNeed(needs, NEED_STUDENT, 'primary_type=student')
  }
  if (
    sections?.education &&
    (sections.education.school_name ||
      sections.education.classification ||
      Array.isArray(sections.education.target_colleges))
  ) {
    pushNeed(needs, NEED_STUDENT, 'education section populated')
  }
  if (sections?.university_applications) {
    pushNeed(needs, NEED_STUDENT, 'university_applications section present')
  }
  for (const t of ['student', 'college', 'university', 'scholarship', 'fafsa']) {
    if (tags.has(t)) pushNeed(needs, NEED_STUDENT, `tag:${t}`)
  }
}

function detectEmployment(needs, profile, sections, tags, haystack) {
  if (sections?.employment && Object.keys(sections.employment).length > 0) {
    pushNeed(needs, NEED_EMPLOYMENT, 'employment section present')
  }
  for (const t of ['workforce', 'job_training', 'unemployed', 'apprentice', 'wioa']) {
    if (tags.has(t)) pushNeed(needs, NEED_EMPLOYMENT, `tag:${t}`)
  }
}

function detectBusiness(needs, profile, sections, tags, haystack) {
  if (
    sections?.small_business_details &&
    Object.keys(sections.small_business_details).length > 0
  ) {
    pushNeed(needs, NEED_BUSINESS, 'small_business_details section present')
  }
  const type = toLowerStr(profile?.primary_type)
  if (
    type.includes('business') ||
    type.includes('llc') ||
    type.includes('startup') ||
    type.includes('entrepreneur')
  ) {
    pushNeed(needs, NEED_BUSINESS, `primary_type=${profile?.primary_type}`)
  }
}

function detectNonprofit(needs, profile, sections, tags, haystack) {
  const type = toLowerStr(profile?.primary_type)
  if (
    type.includes('nonprofit') ||
    type.includes('ministry') ||
    type.includes('church') ||
    type.includes('faith') ||
    type.includes('501c')
  ) {
    pushNeed(needs, NEED_NONPROFIT, `primary_type=${profile?.primary_type}`)
  }
  if (sections?.nonprofit_compliance) {
    pushNeed(needs, NEED_NONPROFIT, 'nonprofit_compliance section present')
  }
  for (const t of ['nonprofit', 'ministry', 'church', 'food_pantry', '501c3']) {
    if (tags.has(t)) pushNeed(needs, NEED_NONPROFIT, `tag:${t}`)
  }
}

function detectFamily(needs, profile, sections, tags, haystack) {
  if (
    (sections?.family && Object.keys(sections.family).length > 0) ||
    (sections?.family_life && Object.keys(sections.family_life).length > 0)
  ) {
    pushNeed(needs, NEED_FAMILY, 'family section present')
  }
  for (const t of ['family', 'caregiver', 'foster', 'adoption', 'parent']) {
    if (tags.has(t)) pushNeed(needs, NEED_FAMILY, `tag:${t}`)
  }
}

function detectMilitary(needs, profile, sections, tags, haystack) {
  if (sections?.military_service && Object.keys(sections.military_service).length > 0) {
    pushNeed(needs, NEED_MILITARY, 'military_service section present')
  }
  for (const t of ['veteran', 'military', 'gold_star', 'spouse_military']) {
    if (tags.has(t)) pushNeed(needs, NEED_MILITARY, `tag:${t}`)
  }
}

function detectEmergency(needs, profile, sections, tags, haystack) {
  const looking = asArray(sections?.basic_information?.looking_for).map(toLowerStr)
  if (looking.includes('emergency_help')) {
    pushNeed(needs, NEED_EMERGENCY, 'looking_for=emergency_help')
  }
  for (const t of ['emergency', 'urgent', 'crisis', 'eviction', 'shutoff']) {
    if (tags.has(t)) pushNeed(needs, NEED_EMERGENCY, `tag:${t}`)
  }
}

function detectLocalState(needs, profile, sections, tags, haystack) {
  // Always push if we have at least a state or ZIP — local programs almost
  // always exist and are usually overlooked.
  const state =
    profile?.state || sections?.basic_information?.state || sections?.location_focus?.state
  const zip =
    profile?.zip || sections?.basic_information?.zip || sections?.location_focus?.zip
  if (state || zip) {
    pushNeed(needs, NEED_LOCAL, state ? `state=${state}` : `zip=${zip}`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ProfileNeedsResult
 * @property {Array} primaryNeeds
 * @property {Array} suggestedSearches
 * @property {Array} missingProfileDetails
 */

/**
 * Interpret a profile + its sections into structured needs.
 *
 * @param {object} args
 * @param {object} args.profile  - raw profiles row
 * @param {object} args.sections - `{ section_key: parsedJsonData }`
 * @param {object} [args.signals] - optional pre-computed signals (future use)
 * @returns {ProfileNeedsResult}
 */
export function interpretProfileNeeds({ profile, sections, signals = null } = {}) {
  const p = profile || {}
  const s = sections || {}
  const tags = tagSet(p, s)
  const haystack = buildHaystack(p, s)

  const needs = []

  detectHousing(needs, p, s, tags, haystack)
  detectHealth(needs, p, s, tags, haystack)
  detectDisability(needs, p, s, tags, haystack)
  detectStudent(needs, p, s, tags, haystack)
  detectEmployment(needs, p, s, tags, haystack)
  detectBusiness(needs, p, s, tags, haystack)
  detectNonprofit(needs, p, s, tags, haystack)
  detectFamily(needs, p, s, tags, haystack)
  detectMilitary(needs, p, s, tags, haystack)
  detectEmergency(needs, p, s, tags, haystack)
  detectLocalState(needs, p, s, tags, haystack)

  // Build suggestedSearches from the detected needs. We dedupe by search
  // string so two needs that share a term don't produce two cards.
  const suggestedSearches = []
  const seenSearchSig = new Set()
  for (const need of needs) {
    const sig = need.searchTerms.join('|')
    if (seenSearchSig.has(sig)) continue
    seenSearchSig.add(sig)
    suggestedSearches.push({
      title: `Search for ${need.plainEnglish}`,
      explanation: `This profile shows ${need.plainEnglish}, so these searches may help.`,
      searchQuery: need.searchTerms.slice(0, 4).join(' '),
      searchTerms: need.searchTerms,
      grantflowRoute: need.grantflowSearch?.route || 'DiscoverGrants',
      recommendedFilters: need.grantflowSearch?.filters || discoveryFilters(),
    })
  }

  // Missing profile details — only flag truly impactful gaps. Each missing
  // detail must have a clear "why" so the prompt can be plain-English.
  const missingProfileDetails = []

  if (!p?.state && !s?.basic_information?.state && !s?.location_focus?.state) {
    missingProfileDetails.push({
      section_key: 'basic_information',
      field: 'state',
      reason: 'State is required to find state and local funding programs.',
    })
  }
  if (!p?.zip && !s?.basic_information?.zip && !s?.location_focus?.zip) {
    missingProfileDetails.push({
      section_key: 'basic_information',
      field: 'zip',
      reason: 'ZIP unlocks county and city programs that are usually overlooked.',
    })
  }
  if (
    needs.find((n) => n.key === 'housing_stability') &&
    !s?.housing?.monthly_housing_cost &&
    !s?.financial_information?.monthly_housing_cost
  ) {
    missingProfileDetails.push({
      section_key: 'housing',
      field: 'monthly housing cost',
      reason:
        'Adding this can improve matches for rent, utility, and housing stability programs.',
    })
  }
  if (
    needs.find((n) => n.key === 'student_aid') &&
    !s?.education?.school_name &&
    !Array.isArray(s?.education?.target_colleges)
  ) {
    missingProfileDetails.push({
      section_key: 'education',
      field: 'school name',
      reason:
        'Naming the school lets GrantFlow find institutional aid and emergency funds the school itself offers.',
    })
  }
  if (
    needs.find((n) => n.key === 'small_business') &&
    !s?.small_business_details?.ein
  ) {
    missingProfileDetails.push({
      section_key: 'small_business_details',
      field: 'EIN',
      reason: 'EIN is required for most small-business grants and SBA programs.',
    })
  }
  if (
    needs.find((n) => n.key === 'nonprofit_capacity') &&
    !s?.nonprofit_compliance?.ein
  ) {
    missingProfileDetails.push({
      section_key: 'nonprofit_compliance',
      field: 'EIN',
      reason: 'EIN and 501(c)(3) status are required for most foundation grants.',
    })
  }

  return { primaryNeeds: needs, suggestedSearches, missingProfileDetails }
}

/**
 * Convenience wrapper: load `sections` from the database via the same
 * shape `loadProfileContext()` uses, then interpret.
 *
 * Kept separate from `interpretProfileNeeds()` so the unit tests can stay
 * fully in-memory (no db).
 */
export async function interpretProfileNeedsFromDb(db, profileId) {
  const profile = await db
    .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
    .get(profileId)
  if (!profile) return { primaryNeeds: [], suggestedSearches: [], missingProfileDetails: [] }

  const rows = await db
    .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
    .all(profileId)
  const sections = {}
  for (const r of rows || []) {
    sections[r.section_key] = safeParseJSON(r.data, {})
  }
  return interpretProfileNeeds({ profile, sections })
}
