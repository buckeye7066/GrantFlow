/**
 * Profile Normalizer
 *
 * Produces a canonical profile structure from raw profile + sections data.
 * Handles aliasing between old/new field names, entity type normalization,
 * need category normalization, and fingerprint computation.
 */

import { createHash } from 'crypto'
import { resolveApplicantType } from './profileHelpers.js'
import { NAMED_CONDITION_FLAGS } from '../config/conditionSpecificity.js'

const FALSEY_TEXT_VALUES = new Set([
  '',
  '0',
  'false',
  'no',
  'none',
  'n/a',
  'na',
  'not applicable',
  'not-applicable',
  'not specified',
  'unspecified',
  'unknown',
  'prefer not to say',
])

function asBoolNullable(v) {
  if (v === true) return true
  if (v === false) return false
  if (v === 1 || v === '1') return true
  if (v === 0 || v === '0') return false
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['yes', 'true', 'y', 't', 'on'].includes(s)) return true
    if (FALSEY_TEXT_VALUES.has(s) || ['n', 'f', 'off'].includes(s)) return false
  }
  return null
}

function hasSpecificTextValue(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  return !FALSEY_TEXT_VALUES.has(s)
}

function hasSpecificAnswerValue(value) {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' || typeof value === 'number') return hasSpecificTextValue(value)
  if (Array.isArray(value)) return value.some((entry) => hasSpecificAnswerValue(entry))
  if (typeof value === 'object') return Object.values(value).some((entry) => hasSpecificAnswerValue(entry))
  return false
}

// ---------------------------------------------------------------------------
// State name → 2-letter abbreviation. Used to normalize the multi-state
// `states[]` array (which may carry full names like "Tennessee") so geo
// matching can compare them against opportunity state codes.
// ---------------------------------------------------------------------------
const STATE_NAME_TO_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
}

// ---------------------------------------------------------------------------
// Need category alias map
// Multiple names can refer to the same canonical need bucket.
// ---------------------------------------------------------------------------
export const NEED_ALIAS_MAP = {
  // Housing / shelter
  housing: 'housing',
  housing_instability: 'housing',
  rent: 'housing',
  rental_assistance: 'housing',
  housing_repair: 'housing',
  home_repair: 'housing',
  homeless: 'housing',
  homelessness: 'housing',
  eviction: 'housing',
  eviction_prevention: 'housing',
  mortgage: 'housing',

  // Utilities
  utilities: 'utilities',
  utility: 'utilities',
  electric: 'utilities',
  gas: 'utilities',
  water: 'utilities',
  internet: 'utilities',

  // Medical / health
  medical: 'health_medical',
  health: 'health_medical',
  health_medical: 'health_medical',
  healthcare: 'health_medical',
  medical_bills: 'health_medical',
  prescription: 'health_medical',
  mental_health: 'health_medical',
  behavioral_health: 'health_medical',
  dental: 'health_medical',
  vision: 'health_medical',

  // Food
  food: 'food',
  nutrition: 'food',
  food_insecurity: 'food',
  groceries: 'food',
  snap: 'food',

  // Employment / workforce
  employment: 'employment',
  job: 'employment',
  jobs: 'employment',
  workforce: 'employment',
  job_training: 'employment',
  career: 'employment',

  // Education / student
  education: 'education',
  student: 'education',
  college: 'education',
  tuition: 'education',
  scholarship: 'education',
  school: 'education',
  training: 'education',
  vocational: 'education',
  financial_aid: 'education',
  textbooks: 'education',
  books: 'education',
  fellowship: 'education',

  // Professional development / continuing education / licensure remediation
  // (top-level taxonomy bucket per spec section 2). These map to the
  // professional_development category — distinct from K–12 / college
  // education, which keeps general scholarship results from polluting
  // licensed-professional CE searches.
  professional_development: 'professional_development',
  continuing_education: 'professional_development',
  cme: 'professional_development',
  ceu: 'professional_development',
  ce: 'professional_development',
  license_reinstatement: 'professional_development',
  license_reinstatement_support: 'professional_development',
  licensure: 'professional_development',
  licensure_exam: 'professional_development',
  recertification: 'professional_development',
  credentialing: 'professional_development',
  remediation_course: 'professional_development',
  ethics_training: 'professional_development',
  professional_remediation_funding: 'professional_development',
  nursing_reentry_support: 'professional_development',
  workforce_reentry_training: 'professional_development',
  certification_assistance: 'professional_development',

  // Disability
  disability: 'disability',
  chronic_illness: 'disability',
  adaptive_equipment: 'disability',
  assistive_technology: 'disability',
  dme: 'disability',

  // Caregiver / family
  caregiver: 'family_life',
  family: 'family_life',
  family_life: 'family_life',
  childcare: 'family_life',
  child_care: 'family_life',
  parenting: 'family_life',
  family_support: 'family_life',
  child: 'family_life',
  children: 'family_life',
  foster: 'family_life',
  adoption: 'family_life',

  // Transportation
  transportation: 'transportation',
  vehicle: 'transportation',
  car: 'transportation',
  bus: 'transportation',
  transit: 'transportation',

  // Business / entrepreneurship
  business: 'business',
  small_business: 'business',
  entrepreneurship: 'business',
  startup: 'business',
  self_employment: 'business',
  entrepreneur: 'business',
  microenterprise: 'business',

  // Nonprofit / church / faith-based
  nonprofit: 'nonprofit_ministry',
  church: 'nonprofit_ministry',
  faith: 'nonprofit_ministry',
  ministry: 'nonprofit_ministry',
  religious: 'nonprofit_ministry',
  community_organization: 'nonprofit_ministry',

  // Research / arts
  research: 'research_arts',
  arts: 'research_arts',
  artist: 'research_arts',
  culture: 'research_arts',
  creative: 'research_arts',

  // Emergency / crisis
  emergency: 'emergency',
  crisis: 'emergency',
  disaster: 'emergency',
  fema: 'emergency',
  emergency_assistance: 'emergency',

  // Veteran
  veteran: 'veteran',
  veterans: 'veteran',
  military: 'veteran',
  armed_forces: 'veteran',

  // Clothing / personal items
  clothing: 'clothing_goods',
  goods: 'clothing_goods',
  household_goods: 'clothing_goods',
  furniture: 'clothing_goods',
  uniforms: 'clothing_goods',
  work_clothing: 'clothing_goods',
  work_uniforms: 'clothing_goods',
  work_clothes: 'clothing_goods',
  professional_clothing: 'clothing_goods',
  interview_clothing: 'clothing_goods',

  // Technology / equipment / digital access
  technology: 'technology_equipment',
  computer: 'technology_equipment',
  laptop: 'technology_equipment',
  desktop: 'technology_equipment',
  tablet: 'technology_equipment',
  hotspot: 'technology_equipment',
  wifi: 'technology_equipment',
  broadband: 'technology_equipment',
  digital_access: 'technology_equipment',
  digital_equity: 'technology_equipment',
  digital_inclusion: 'technology_equipment',
  device: 'technology_equipment',
  phone: 'technology_equipment',
  cell_phone: 'technology_equipment',
  smartphone: 'technology_equipment',
  equipment: 'technology_equipment',

  // Cash assistance / financial aid
  cash_assistance: 'cash_assistance',
  income_support: 'cash_assistance',
  financial_assistance: 'cash_assistance',
  tanf: 'cash_assistance',
  ssi: 'cash_assistance',
  ssdi: 'cash_assistance',

  // Legal services
  legal: 'legal',
  legal_aid: 'legal',
  legal_help: 'legal',

  // Agriculture / farming (the Anita class, 2026-08-01)
  //
  // `agriculture` was already a canonical BROWSE category
  // (constants/needCategories.js) and both agriculture gates in
  // services/matchEngine.js test for it by name —
  //   :572  `!profileNorm.needCategories.includes('agriculture')`  (the
  //         `requiresFarmer` softener: without an 'agriculture' need the
  //         `clearlyNotAgricultural` branch fires and a real farm applicant is
  //         handed a hard `Requires agricultural producer status` ineligibility)
  //   :2792 the ag-signal score cap
  // — but the map's RANGE never contained it, so no profile could ever hold it
  // as a bucket. That also left it out of NEED_BUCKET_IDS, i.e. out of the
  // user-pickable `needs` vocabulary (config/profileVocabulary.js:45), so
  // `mapFreeTextToNeedTag('farming')` returned null and a farm's need fell
  // through as an unmapped raw passthrough key no consumer recognises.
  //
  // Keys are deliberately high-precision: every key here also becomes a
  // DOCUMENT-TEXT keyword (_ensureNeedKeywordIndex below), so bare 'crop',
  // 'produce' and 'ranch' are excluded — they are common words and place-name
  // fragments, and this is the documented substring-explosion class.
  agriculture: 'agriculture',
  agricultural: 'agriculture',
  farm: 'agriculture',
  farming: 'agriculture',
  farmer: 'agriculture',
  farmers: 'agriculture',
  farmland: 'agriculture',
  farm_operation: 'agriculture',
  family_farm: 'agriculture',
  ranching: 'agriculture',
  rancher: 'agriculture',
  livestock: 'agriculture',
  crop_production: 'agriculture',
  agribusiness: 'agriculture',
  agricultural_producer: 'agriculture',
  value_added_producer: 'agriculture',
  soil_conservation: 'agriculture',

  // Substance recovery (maps to health_medical)
  substance_recovery: 'health_medical',
  substance_abuse: 'health_medical',
  addiction: 'health_medical',
  rehab: 'health_medical',
  recovery: 'health_medical',
}

// ---------------------------------------------------------------------------
// Entity type alias map
// ---------------------------------------------------------------------------
export const ENTITY_TYPE_ALIAS_MAP = {
  individual: 'individual',
  individual_need: 'individual',
  person: 'individual',
  family: 'individual',
  household: 'individual',
  adult: 'individual',
  senior: 'individual',

  student: 'student',
  college_student: 'student',
  graduate_student: 'student',
  high_school_student: 'student',
  k12_student: 'student',
  undergraduate: 'student',

  veteran: 'veteran',
  military_veteran: 'veteran',

  caregiver: 'caregiver',
  foster_parent: 'caregiver',
  parent: 'caregiver',

  nonprofit: 'nonprofit',
  '501c3': 'nonprofit',
  charity: 'nonprofit',
  ngo: 'nonprofit',
  community_organization: 'nonprofit',
  faith_based: 'nonprofit',
  church: 'nonprofit',
  ministry: 'nonprofit',
  religious_organization: 'nonprofit',
  volunteer_fire: 'nonprofit',
  fire_department: 'nonprofit',
  volunteer_fire_department: 'nonprofit',
  ems: 'nonprofit',
  emergency_services: 'nonprofit',
  fire_station: 'nonprofit',
  first_responder_org: 'nonprofit',
  rescue_squad: 'nonprofit',

  business: 'business',
  small_business: 'business',
  entrepreneur: 'business',
  startup: 'business',
  self_employed: 'business',
  llc: 'business',
  corporation: 'business',

  researcher: 'researcher',
  academic: 'researcher',
  scientist: 'researcher',
  faculty: 'researcher',

  artist: 'artist',
  creative: 'artist',

  organization: 'organization',
  institution: 'organization',
  government: 'organization',
  school: 'organization',
  school_district: 'organization',
  k12_school: 'organization',
  charter_school: 'organization',
  public_school: 'organization',
  private_school: 'organization',
  library: 'organization',
  housing_authority: 'organization',
  tribal_organization: 'organization',

  // Research-capable organizations (the Axiom BioLabs class, 2026-07-06):
  // these raw types used to leak through unmapped as literal entityTypes
  // ('biotechnology'), breaking every entityType === '...' comparison in the
  // eligibility gates — a declared research org was then rejected from the
  // research-institution mechanisms it exists to pursue.
  biotechnology: 'organization',
  biotech: 'organization',
  research_organization: 'organization',
  research_institution: 'organization',
  research_institute: 'organization',
  laboratory: 'organization',
  life_sciences: 'organization',
  university: 'organization',
  hospital: 'organization',
  medical_center: 'organization',

  // Agricultural producer (the Anita class, 2026-08-01). `farm` is already a
  // first-class entity type downstream — it is in `ORG_LIKE_ENTITY_TYPES`
  // (services/matchEngine.js) and BOTH agriculture gates compare against it by
  // name (`:569` requiresFarmer softener, `:2790` ag score cap) — but the alias
  // map never produced it, so only the exact literal string 'farm' reached
  // those gates by raw passthrough. Every way a real profile actually writes
  // the identity ('farmer', 'rancher', 'agricultural producer', 'agribusiness')
  // fell through as its own raw key and silently missed every comparison, the
  // same failure the biotechnology block above exists to fix.
  farm: 'farm',
  farmer: 'farm',
  farming: 'farm',
  farm_operation: 'farm',
  family_farm: 'farm',
  ranch: 'farm',
  rancher: 'farm',
  agricultural_producer: 'farm',
  agriculture_producer: 'farm',
  agricultural_business: 'farm',
  agribusiness: 'farm',
  grower: 'farm',
}

// ---------------------------------------------------------------------------
// Normalize a need category string to canonical value
// ---------------------------------------------------------------------------
export function normalizeNeedCategory(raw) {
  if (!raw || typeof raw !== 'string') return null
  const key = raw.toLowerCase().trim().replace(/[\s-]+/g, '_')
  return NEED_ALIAS_MAP[key] ?? key
}

// ---------------------------------------------------------------------------
// Normalize entity type to canonical value
// ---------------------------------------------------------------------------
export function normalizeEntityType(raw) {
  if (!raw || typeof raw !== 'string') return null
  const key = raw.toLowerCase().trim().replace(/[\s-]+/g, '_')
  if (ENTITY_TYPE_ALIAS_MAP[key]) return ENTITY_TYPE_ALIAS_MAP[key]
  // Unmapped free-text org types ("Biotechnology / research organization")
  // used to leak through as literal entityTypes, silently failing every
  // entityType === '...' gate downstream. Recognizably org-shaped strings
  // collapse to the canonical org bucket; anything else keeps the raw key
  // (compat with callers that pass custom types).
  if (/(organi[sz]ation|institut|universit|hospital|laborator|research|biotech|life_scien|foundation|agency|coalition|consortium)/.test(key)) {
    return 'organization'
  }
  return key
}

// ---------------------------------------------------------------------------
// Safe JSON parse helper
// ---------------------------------------------------------------------------
function safeParseArray(val) {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return []
}

// ---------------------------------------------------------------------------
// Document-derived signal extraction (RC-17)
//
// Folds `documents.extracted_text` from uploaded profile documents into the
// canonical need vocabulary. Bounded to NEED_ALIAS_MAP keys so a malicious
// or noisy document can't add anything outside the existing taxonomy.
// ---------------------------------------------------------------------------
const DOCUMENT_TEXT_SCAN_CAP = 200_000  // 200 KB total, prevents pathological scans
// Pre-build the canonical-need vocabulary as { canonical: Set<keyword>}.
// Each NEED_ALIAS_MAP key becomes a keyword for its canonical bucket.
// Whitespace is added inside the keyword so a free-text document like
// "we need housing repair help" still matches "housing_repair" (we strip
// underscores when scanning).
let _NEED_KEYWORDS_BY_CANONICAL = null
function _ensureNeedKeywordIndex() {
  if (_NEED_KEYWORDS_BY_CANONICAL) return _NEED_KEYWORDS_BY_CANONICAL
  const map = new Map()
  for (const [alias, canonical] of Object.entries(NEED_ALIAS_MAP)) {
    if (!canonical) continue
    const normalized = String(alias).toLowerCase().replace(/_/g, ' ').trim()
    if (!normalized) continue
    if (!map.has(canonical)) map.set(canonical, new Set())
    map.get(canonical).add(normalized)
  }
  _NEED_KEYWORDS_BY_CANONICAL = map
  return map
}

/**
 * Scan an extracted-text blob for canonical need keywords. Returns the
 * set of canonical need buckets the document touched. Bounded to the
 * NEED_ALIAS_MAP vocabulary so we cannot introduce new buckets from
 * uploaded text.
 *
 * Each canonical bucket fires at most once even when many keywords match,
 * which keeps documentSignals stable for fingerprinting.
 */
export function extractNeedSignalsFromDocumentText(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return []
  const haystack = rawText
    .toLowerCase()
    .replace(/[\u00a0]/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, DOCUMENT_TEXT_SCAN_CAP)
  // Build the token set ONCE so single-word aliases (e.g. "ce" = continuing
  // education, "rent", "water") match only as discrete word tokens — never as
  // a substring inside an unrelated word like "noti**ce**" or "g**roce**ries".
  // Multi-word aliases (after underscore→space normalization, e.g. "small
  // business") still match as substrings, since their composition makes
  // collisions vanishingly rare.
  const tokenSet = new Set(
    haystack.split(/[^a-z0-9]+/).filter(Boolean),
  )
  const index = _ensureNeedKeywordIndex()
  const hits = new Set()
  for (const [canonical, keywords] of index) {
    for (const kw of keywords) {
      const isPhrase = kw.indexOf(' ') !== -1
      if (isPhrase ? haystack.includes(kw) : tokenSet.has(kw)) {
        hits.add(canonical)
        break
      }
    }
  }
  return Array.from(hits)
}

/**
 * Pull all extracted_text strings out of a documents argument. Accepts:
 *   - an array of { extracted_text } rows
 *   - { documents: [...] }
 *   - a single string (already concatenated)
 * Returns one combined string (cap-bounded) or null when nothing usable.
 */
function _coerceDocumentsToText(documents) {
  if (!documents) return null
  const list = Array.isArray(documents)
    ? documents
    : Array.isArray(documents?.documents)
      ? documents.documents
      : null
  if (Array.isArray(list)) {
    const parts = []
    let total = 0
    for (const doc of list) {
      const text = typeof doc === 'string'
        ? doc
        : typeof doc?.extracted_text === 'string'
          ? doc.extracted_text
          : null
      if (!text) continue
      // Reserve a soft cap so a single huge doc cannot starve the others.
      const remaining = DOCUMENT_TEXT_SCAN_CAP - total
      if (remaining <= 0) break
      const slice = text.length > remaining ? text.slice(0, remaining) : text
      parts.push(slice)
      total += slice.length
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  if (typeof documents === 'string') return documents
  return null
}

// ---------------------------------------------------------------------------
// Normalize a profile + sections into a canonical structure
// ---------------------------------------------------------------------------
/**
 * Normalize a raw profile and its sections into the canonical structure used
 * by the decision engine.
 *
 * @param {Object} rawProfile     - Raw profile row or { profile, sections } object
 * @param {Object|null} sections  - Profile sections keyed by section name
 * @param {Object|null} signals   - Optional signals object from buildProfileSignals().
 *   When provided, signals.needs (a Set of inferred need strings) is merged into
 *   needCategories after the normalizer's own extraction, canonicalized via NEED_ALIAS_MAP.
 *   This bridges the rich signal engine output into the scoring pipeline.
 * @param {Array|Object|string|null} documents
 *   Optional documents bundle. Accepts an array of `{ extracted_text }`
 *   rows, an object with a `.documents` array, or a single concatenated
 *   string. Document-derived needs are bounded to the NEED_ALIAS_MAP
 *   vocabulary so uploads cannot introduce noise (RC-17).
 * @returns {Object|null} Normalized profile or null if rawProfile is falsy
 */
export function normalizeProfile(rawProfile, sections = null, signals = null, documents = null) {
  if (!rawProfile) return null

  const profile = rawProfile?.profile ?? rawProfile
  const profileSections = sections ?? rawProfile?.sections ?? {}

  // -- Entity type --
  const rawType =
    resolveApplicantType(profile) ??
    profile.type ??
    profile.entity_type ??
    null
  const entityType = normalizeEntityType(rawType)

  // -- Location: top-level first, then fall back to sections --
  let state = profile.state ?? profile.primary_state ?? null
  let zip = profile.postal_code ?? profile.zip_code ?? profile.zip ?? null
  let county = profile.county ?? null
  let city = profile.city ?? null

  // Collect ALL of the profile's states (primary + secondary address + the
  // multi-state `states[]` array on basic_information / location_focus). This
  // makes a two-address (or multi-state service-area) profile match local
  // opportunities in EVERY one of its states — not just the primary. Stored
  // primary-first, deduped, 2-letter normalized. Empty when no state is known
  // (callers MUST treat empty as NEUTRAL, never a penalty).
  const _stateAccumulator = []
  const _addState = (raw) => {
    if (!raw) return
    const norm = String(raw).trim().toUpperCase()
    const two = STATE_NAME_TO_ABBR[norm.toLowerCase()] ?? (norm.length === 2 ? norm : null)
    if (two && !_stateAccumulator.includes(two)) _stateAccumulator.push(two)
  }

  // Extract location from sections if top-level is incomplete.
  // Check standard section keys used in real profile data.
  if ((!state || !zip) && profileSections) {
    const locationCandidates = [
      profileSections.basic_information,    // most common real section
      profileSections.location_focus,       // service/preferred location
      profileSections.location,
      profileSections.address,
      profileSections.contact_info,
    ]
    for (const section of locationCandidates) {
      if (!section) continue
      const la = section.answers ?? section
      if (!la || typeof la !== 'object') continue
      if (!state) {
        // Handle nested address objects like { address: { state: 'TN' } }
        const addrObj = la.address && typeof la.address === 'object' ? la.address : null
        state = la.state ?? la.primary_state ?? addrObj?.state ?? null
        // Parse state from a string address like "123 Main St, Nashville, TN 37201"
        if (!state && typeof la.address === 'string') {
          const m = la.address.match(/\b([A-Z]{2})\s{0,10},?\s{0,10}\d{5}/)
          if (m) state = m[1]
        }
      }
      if (!zip) {
        const addrObj = la.address && typeof la.address === 'object' ? la.address : null
        zip = la.zip ?? la.postal_code ?? la.zip_code ?? addrObj?.zip ?? addrObj?.postal_code ?? null
      }
      if (!county) county = la.county ?? null
      if (!city) city = la.city ?? null
      if (state && zip) break // Got everything we need
    }
    // Also check organization section
    const orgSection = profileSections.organization ?? profileSections.org ?? null
    if (orgSection) {
      const oa = orgSection.answers ?? orgSection
      if (oa && typeof oa === 'object') {
        if (!state) state = oa.state ?? null
        if (!zip) zip = oa.zip ?? oa.postal_code ?? null
        if (!city) city = oa.city ?? null
      }
    }
  }

  // -- Multi-state collection (primary + secondary address + states[]) --
  // Primary first (so single-address behavior is unchanged), then the
  // secondary address, then any explicit multi-state arrays. This is the
  // canonical list the matcher uses to claim in-state for ANY address.
  _addState(state)
  const _basicInfo = profileSections?.basic_information?.answers ?? profileSections?.basic_information ?? null
  const _locFocus = profileSections?.location_focus?.answers ?? profileSections?.location_focus ?? null
  // Secondary address: structured object or freeform string.
  const _secondary = _basicInfo?.secondary_address ?? null
  if (_secondary && typeof _secondary === 'object') {
    _addState(_secondary.state ?? _secondary.region ?? null)
  } else if (typeof _secondary === 'string') {
    const m = _secondary.match(/\b([A-Za-z]{2})\s{0,10},?\s{0,10}\d{5}/)
    if (m) _addState(m[1])
  }
  // Explicit states[] arrays on the profile, basic_information, or location_focus.
  for (const arr of [
    safeParseArray(profile.states),
    safeParseArray(_basicInfo?.states),
    safeParseArray(_locFocus?.states),
    safeParseArray(_locFocus?.service_states),
  ]) {
    for (const s of arr) _addState(s)
  }
  // Merge any states surfaced by buildProfileSignals (primary + secondary
  // resolved with the offline ZIP DB). Keeps profileNorm.states in sync with
  // signals.states without depending on call order.
  if (Array.isArray(signals?.states)) {
    for (const s of signals.states) _addState(s)
  }
  const states = _stateAccumulator.slice()

  // -- Need categories --
  const rawNeeds = [
    ...safeParseArray(profile.needs),
    ...safeParseArray(profile.need_categories),
    ...safeParseArray(profile.tags),
  ]

  // Pull needs from profile sections too
  if (profileSections) {
    for (const [sectionKey, sectionData] of Object.entries(profileSections)) {
      if (!sectionData) continue
      const answers = sectionData.answers ?? sectionData
      if (answers && typeof answers === 'object') {
        // Look for need-related section keys
        const needKeys = ['needs', 'need_categories', 'primary_needs', 'support_needs']
        for (const nk of needKeys) {
          if (answers[nk]) rawNeeds.push(...safeParseArray(answers[nk]))
        }
      }
      const sectionHasSpecificAnswers = hasSpecificAnswerValue(answers)
      // Section key itself may be a need category (e.g. "medical", "housing")
      if (sectionHasSpecificAnswers && NEED_ALIAS_MAP[sectionKey.toLowerCase()]) {
        rawNeeds.push(sectionKey)
      }
      // Also handle '_information' suffix keys used in real profile sections
      // e.g. "health_information" → "health" → maps to "health_medical"
      // e.g. "housing_information" → "housing", "education_information" → "education"
      const baseKey = sectionKey.toLowerCase().replace(/_information$/, '')
      if (sectionHasSpecificAnswers && baseKey !== sectionKey.toLowerCase() && NEED_ALIAS_MAP[baseKey]) {
        rawNeeds.push(baseKey)
      }
    }
  }

  const needCategories = [...new Set(rawNeeds.map(normalizeNeedCategory).filter(Boolean))]

  // -- Merge signals.needs from buildProfileSignals() if provided --
  // The signal engine produces a richer set of inferred needs from profile sections
  // (healthcare, employment, cash_assistance, transportation, etc.) that normalizeProfile()
  // may not extract on its own. Merge these in using the alias map so they're canonical.
  if (signals?.needs instanceof Set) {
    for (const need of signals.needs) {
      const canonical = normalizeNeedCategory(need)
      if (canonical && !needCategories.includes(canonical)) {
        needCategories.push(canonical)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Derive richer signals from section content
  // ---------------------------------------------------------------------------

  // -- Veteran status: top-level flags or military_service section --
  let isVeteranFromSections = false
  const militarySection =
    profileSections?.military_service ??
    profileSections?.military ??
    profileSections?.veteran ??
    null
  if (militarySection) {
    const ma = militarySection.answers ?? militarySection
    if (ma && typeof ma === 'object') {
      isVeteranFromSections =
        asBoolNullable(ma.is_veteran) === true ||
        asBoolNullable(ma.veteran) === true ||                        // common field name: { veteran: true }
        asBoolNullable(ma.served_in_military) === true ||
        asBoolNullable(ma.military_service) === true ||
        asBoolNullable(ma.veteran_status) === true ||
        hasSpecificTextValue(ma.branch) ||
        hasSpecificTextValue(ma.military_branch) || // common field: military_branch: "Army"
        hasSpecificTextValue(ma.discharge_status)
    }
  }

  const isVeteran =
    asBoolNullable(profile.is_veteran) === true ||
    entityType === 'veteran' ||
    needCategories.includes('veteran') ||
    String(rawType ?? '').toLowerCase().includes('veteran') ||
    isVeteranFromSections

  // -- Student status: top-level flags or education section --
  let isStudentFromSections = false
  const educationSection =
    profileSections?.education ??
    profileSections?.education_information ??
    profileSections?.student ??
    null
  if (educationSection) {
    const ea = educationSection.answers ?? educationSection
    if (ea && typeof ea === 'object') {
      isStudentFromSections =
        Boolean(ea.is_student) ||
        Boolean(ea.currently_enrolled) ||
        Boolean(ea.enrolled_in_school) ||
        Boolean(ea.first_generation) ||              // first-gen college student signal
        String(ea.school_name ?? '').length > 0 ||
        String(ea.grade_level ?? '').length > 0 ||
        String(ea.degree_program ?? '').length > 0 ||
        String(ea.field_of_study ?? '').length > 0 || // common field: field_of_study
        String(ea.highest_level ?? '').length > 0    // common field: highest_level: "high school"
    }
  }

  // A FAMILY/HOUSEHOLD profile's education section describes the CHILDREN, not
  // the applicant (the homeschool_family class, 2026-08-02). The synthetic
  // homeschool parent declares education.highest_level 'homeschool (K-12)', and
  // the section heuristic above promoted the PARENT to an enrolled student —
  // so matchEngine's non-student × student-aid cap never fired and
  // enrolled-student aid could ACCEPT for a profile that cannot receive it
  // (Amy's ineligible_match ×2, 2026-08-01 cohort). The applicant on a
  // family-type profile is the parent: only an explicit top-level
  // is_student=true or a student-typed profile makes it a student. Student
  // ADJACENCY is untouched — matchEngine.isStudentAdjacent still sees the
  // education section, so requires_student aid for a family with an enrolled
  // child is held at REVIEW, never hard-rejected.
  const isFamilyHouseholdType = /famil|household/.test(String(rawType ?? '').toLowerCase())

  const isStudent =
    asBoolNullable(profile.is_student) === true ||
    entityType === 'student' ||
    String(rawType ?? '').toLowerCase().includes('student') ||
    (isStudentFromSections && !isFamilyHouseholdType)

  // -- Nonprofit status --
  // Includes volunteer fire departments, EMS organizations, churches, ministries, and
  // other community service organizations that operate as nonprofits even if not 501(c)(3).
  const rawTypeLower = String(rawType ?? '').toLowerCase()
  const isNonprofit =
    asBoolNullable(profile.is_nonprofit) === true ||
    asBoolNullable(profile.requires_501c3) === true ||
    entityType === 'nonprofit' ||
    rawTypeLower.includes('nonprofit') ||
    rawTypeLower.includes('volunteer_fire') ||
    rawTypeLower.includes('fire_department') ||
    rawTypeLower.includes('church') ||
    rawTypeLower.includes('ministry') ||
    rawTypeLower.includes('rescue_squad') ||
    rawTypeLower.includes('ems')

  // -- Business status: top-level flags or business section --
  let isBusinessFromSections = false
  const businessSection =
    profileSections?.business ??
    profileSections?.small_business_details ??       // common section key in real profiles
    profileSections?.self_employment ??
    profileSections?.entrepreneurship ??
    null
  if (businessSection) {
    const ba = businessSection.answers ?? businessSection
    if (ba && typeof ba === 'object') {
      isBusinessFromSections =
        asBoolNullable(ba.owns_business) === true ||
        asBoolNullable(ba.is_self_employed) === true ||
        asBoolNullable(ba.has_business) === true ||
        hasSpecificTextValue(ba.business_name) ||
        hasSpecificTextValue(ba.naics_code) ||    // common business field
        hasSpecificTextValue(ba.ein)
    }
  }

  const isBusiness =
    asBoolNullable(profile.is_business) === true ||
    entityType === 'business' ||
    String(rawType ?? '').toLowerCase().includes('business') ||
    isBusinessFromSections

  // -- Caregiver / family: family_life section, dependents, foster indicators --
  let isCaregiverFromSections = false
  // Profile-level fallback first: section-less callers (the crawler-os thesis
  // path) carry the structured flag directly on the profile object.
  let hasFosterIndicator =
    Boolean(profile.foster_youth) || Boolean(profile.has_foster_indicator)
  const familySection =
    profileSections?.family_life ??
    profileSections?.family ??
    profileSections?.caregiving ??
    null
  if (familySection) {
    const fa = familySection.answers ?? familySection
    if (fa && typeof fa === 'object') {
      isCaregiverFromSections =
        Boolean(fa.is_caregiver) ||
        Boolean(fa.caregiver) ||
        Boolean(fa.provides_care) ||
        Boolean(fa.has_dependents) ||
        Boolean(fa.cares_for_family_member) ||
        Number(fa.number_of_dependents ?? 0) > 0 ||
        Number(fa.num_dependents ?? 0) > 0
      hasFosterIndicator = hasFosterIndicator ||
        Boolean(fa.is_foster_parent) ||
        Boolean(fa.foster_care) ||
        Boolean(fa.has_foster_children) ||
        // The schema's own family_life flag for current/FORMER foster youth —
        // without it, a real foster youth's Chafee/ETV lane was REVIEW-capped
        // by the foster-youth restriction gate as "status unknown".
        Boolean(fa.foster_youth) ||
        Boolean(fa.former_foster_youth) ||
        String(fa.foster_status ?? '').toLowerCase().includes('foster')
    }
  }

  const isCaregiver =
    Boolean(profile.is_caregiver) ||
    entityType === 'caregiver' ||
    isCaregiverFromSections ||
    needCategories.includes('family_life')

  // -- Disability / chronic illness / DME --
  let hasChronicIllnessFromSections = false
  // NAMED conditions the profile actually declares ("autism", "type 2
  // diabetes"), as distinct from the boolean/descriptor flags above. Consumed
  // by config/conditionSpecificity.js so a condition-SPECIFIC opportunity
  // (Autism Speaks, Arthritis Foundation) keeps its boost ONLY for a profile
  // that names a matching condition — a bare "Has disability" flag mints no
  // entry here by construction, and negated prose ("No confirmed medical
  // conditions") is filtered by that module's negation guard.
  const namedHealthConditions = []
  const collectNamedCondition = (value) => {
    if (Array.isArray(value)) { value.forEach(collectNamedCondition); return }
    for (const part of String(value ?? '').split(/[,;\n/]+/)) {
      const t = part.trim()
      if (t) namedHealthConditions.push(t)
    }
  }
  const healthSection =
    profileSections?.health_medical ??
    profileSections?.health_information ??
    profileSections?.medical ??
    profileSections?.health ??
    null
  if (healthSection) {
    const ha = healthSection.answers ?? healthSection
    if (ha && typeof ha === 'object') {
      hasChronicIllnessFromSections =
        Boolean(ha.has_disability) ||
        Boolean(ha.has_chronic_illness) ||
        // common field: { chronic_illness: true }
        Boolean(ha.chronic_illness) ||
        Boolean(ha.has_medical_condition) ||
        Boolean(ha.needs_dme) ||
        Boolean(ha.uses_assistive_technology) ||
        String(ha.conditions ?? '').length > 0 ||
        // common fields: chronic_illness_type, disability_type
        String(ha.chronic_illness_type ?? '').length > 0 ||
        String(ha.disability_type ?? '').length > 0 ||
        safeParseArray(ha.diagnoses).length > 0
      collectNamedCondition(ha.conditions)
      collectNamedCondition(ha.chronic_illness_type)
      collectNamedCondition(ha.disability_type)
      collectNamedCondition(safeParseArray(ha.diagnoses))
      // Canonical boolean flags that NAME a condition (hearing_impairment,
      // visual_impairment, …) — the registry lives in conditionSpecificity.js.
      for (const [flag, term] of Object.entries(NAMED_CONDITION_FLAGS)) {
        if (ha[flag] === true) namedHealthConditions.push(term)
      }
    }
  }

  // Disability is also commonly captured on the DEMOGRAPHICS section
  // (`disability_status: "Has disability"` / boolean), not only on health_medical.
  // Read it here so a profile like demo_senior_applicant (disability declared in demographics)
  // still surfaces the disability facet + need.
  let hasDisabilityFromDemographics = false
  {
    const demoSec = profileSections?.demographics ?? null
    const da = demoSec?.answers ?? demoSec
    if (da && typeof da === 'object') {
      const status = String(da.disability_status ?? '').trim().toLowerCase()
      const negative = ['', 'no', 'none', 'no disability', 'n/a', 'na', 'false', 'not disabled']
      hasDisabilityFromDemographics =
        da.disability_status === true ||
        Boolean(da.has_disability) ||
        (status.length > 0 && !negative.includes(status) &&
          (status.includes('disab') || status === 'yes' || status === 'true' || status.includes('has')))
    }
  }

  const hasDisabilityNeed = needCategories.includes('disability') || hasChronicIllnessFromSections || hasDisabilityFromDemographics
  const hasChronicIllness = hasChronicIllnessFromSections || needCategories.includes('disability') || hasDisabilityFromDemographics

  // Ensure 'disability' is in needCategories when demographics declares it, so
  // need alignment + the disabled facet both fire.
  if (hasDisabilityFromDemographics && !needCategories.includes('disability')) {
    needCategories.push('disability')
  }

  // When chronic illness / disability is section-derived, ensure 'disability' appears in needCategories
  // so need alignment can match against opportunity needTypesSupported.
  if (hasChronicIllnessFromSections && !needCategories.includes('disability')) {
    needCategories.push('disability')
  }

  // -- Emergency / disaster context --
  let hasEmergencyFromSections = false
  const emergencySection =
    profileSections?.emergency ??
    profileSections?.disaster ??
    profileSections?.crisis ??
    null
  if (emergencySection) {
    const ema = emergencySection.answers ?? emergencySection
    if (ema && typeof ema === 'object') {
      hasEmergencyFromSections =
        Boolean(ema.has_emergency) ||
        Boolean(ema.disaster_affected) ||
        Boolean(ema.in_crisis) ||
        Boolean(ema.fema_eligible) ||
        String(ema.disaster_type ?? '').length > 0
    }
  }

  const hasEmergencyNeed = needCategories.includes('emergency') || hasEmergencyFromSections

  // Ensure 'emergency' appears in needCategories when section-derived emergency is detected
  if (hasEmergencyFromSections && !needCategories.includes('emergency')) {
    needCategories.push('emergency')
  }

  // -- Housing instability --
  let hasHousingInstabilityFromSections = false
  const housingSection =
    profileSections?.housing ??
    profileSections?.housing_information ??
    profileSections?.shelter ??
    null
  if (housingSection) {
    const hua = housingSection.answers ?? housingSection
    if (hua && typeof hua === 'object') {
      hasHousingInstabilityFromSections =
        Boolean(hua.housing_instability) ||
        Boolean(hua.risk_of_eviction) ||
        Boolean(hua.homeless) ||
        Boolean(hua.temporary_housing) ||
        String(hua.housing_situation ?? '').toLowerCase().includes('unstable') ||
        String(hua.housing_situation ?? '').toLowerCase().includes('evict')
    }
  }

  const hasHousingNeed = needCategories.includes('housing') || hasHousingInstabilityFromSections

  // Ensure 'housing' appears in needCategories when section-derived housing instability is detected
  if (hasHousingInstabilityFromSections && !needCategories.includes('housing')) {
    needCategories.push('housing')
  }

  // -- Employment need signals --
  let hasEmploymentNeed = false
  const employmentSection =
    profileSections?.employment ??
    profileSections?.employment_information ??
    profileSections?.work ??
    profileSections?.income ??
    null
  if (employmentSection) {
    const empa = employmentSection.answers ?? employmentSection
    if (empa && typeof empa === 'object') {
      hasEmploymentNeed =
        Boolean(empa.unemployed) ||
        Boolean(empa.seeking_employment) ||
        Boolean(empa.needs_job_training) ||
        Boolean(empa.underemployed) ||
        String(empa.employment_status ?? '').toLowerCase().includes('unemployed')
    }
  }

  // Ensure 'employment' appears in needCategories when section-derived employment need is detected
  if (hasEmploymentNeed && !needCategories.includes('employment')) {
    needCategories.push('employment')
  }

  const hasBusinessNeed = needCategories.includes('business') || isBusiness

  // Ensure 'business' appears in needCategories when business status is detected
  if (isBusiness && !needCategories.includes('business')) {
    needCategories.push('business')
  }

  // -- Financial information section: derive need categories from explicit content --
  // Real profiles store financial data in a 'financial_information' section which doesn't
  // directly map to a canonical need type. Parse its content to infer relevant needs.
  const financialSection =
    profileSections?.financial_information ??
    profileSections?.financial ??
    null
  if (financialSection) {
    const fa = financialSection.answers ?? financialSection
    if (fa && typeof fa === 'object') {
      // Combine all text fields to look for explicit need indicators
      const finText = [
        fa.notes, fa.challenges, fa.needs, fa.description, fa.financial_needs,
        fa.housing_costs, fa.rent_mortgage, fa.food_costs, fa.utility_costs,
      ].filter(Boolean).join(' ').toLowerCase()

      const finNeedKeywords = {
        housing: ['rent', 'housing', 'evict', 'mortgage'],
        food: ['food', 'groceries', 'hunger', 'nutrition'],
        utilities: ['utility', 'electric', 'gas bill', 'water bill', 'heating'],
        health_medical: ['medical', 'health', 'prescription'],
      }
      for (const [need, keywords] of Object.entries(finNeedKeywords)) {
        if (!needCategories.includes(need) && keywords.some((kw) => finText.includes(kw))) {
          needCategories.push(need)
        }
      }

      // Low-income household signals: add food and utilities as baseline needs
      const monthlyIncome = Number(fa.monthly_income ?? fa.income ?? 0)
      const annualIncome = Number(fa.annual_income ?? fa.household_income ?? 0)
      const isLowIncome = fa.is_low_income || fa.financial_hardship || fa.receives_benefits ||
        (monthlyIncome > 0 && monthlyIncome < 2000) ||
        (annualIncome > 0 && annualIncome < 24000)
      if (isLowIncome) {
        if (!needCategories.includes('food')) needCategories.push('food')
        if (!needCategories.includes('utilities')) needCategories.push('utilities')
      }
    }
  }

  // -- Age (for scholarship/senior eligibility) --
  const age = profile.age ?? null

  // -- Age group signal --
  const ageGroup = profile.age_group ?? null
  const demographicsSection = profileSections?.demographics ?? null
  let ageGroupFromSections = null
  if (demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da && typeof da === 'object') {
      ageGroupFromSections = da.age_group ?? null
    }
  }
  const resolvedAgeGroup = ageGroup ?? ageGroupFromSections

  // -- Work capability signal --
  let isUnableToWork = false
  if (employmentSection) {
    const empa = employmentSection.answers ?? employmentSection
    if (empa && typeof empa === 'object') {
      isUnableToWork = String(empa.notes ?? '').toLowerCase().includes('not able to work') ||
        String(empa.notes ?? '').toLowerCase().includes('unable to work') ||
        String(empa.notes ?? '').toLowerCase().includes('cannot work') ||
        String(empa.current_status ?? '').toLowerCase().includes('disabled')
    }
  }

  // -- Already-enrolled government programs signal --
  const govSection = profileSections?.government_assistance ?? null
  const enrolledPrograms = []
  if (govSection) {
    const ga = govSection.answers ?? govSection
    if (ga && typeof ga === 'object') {
      if (ga.medicaid_enrolled || ga.medicaid) enrolledPrograms.push('medicaid')
      if (ga.medicare_recipient || ga.medicare) enrolledPrograms.push('medicare')
      if (ga.ssi_recipient || ga.ssi) enrolledPrograms.push('ssi')
      if (ga.ssdi_recipient || ga.ssdi) enrolledPrograms.push('ssdi')
      if (ga.snap_recipient || ga.snap) enrolledPrograms.push('snap')
      if (ga.tanf_recipient || ga.tanf) enrolledPrograms.push('tanf')
      if (ga.section8_housing || ga.section_8) enrolledPrograms.push('section8')
    }
  }

  // -- Ethnicity signal --
  let ethnicity = profile.ethnicity ?? null
  if (!ethnicity && demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da && typeof da === 'object') {
      ethnicity = da.ethnicity ?? da.race ?? null
    }
  }

  // Canonical ethnicity bucket — the single signal the matcher compares against
  // an opportunity's explicit ethnicity restriction. Derived from the free-text
  // ethnicity/race string and (as a fallback) the boolean demographics tokens
  // collected below. null = unknown ⇒ NEUTRAL (never a hard reject).
  const _ethnicityBucketFromText = (raw) => {
    if (!raw || typeof raw !== 'string') return null
    const r = raw.toLowerCase()
    if (/\b(african[\s-]?american|black)\b/.test(r)) return 'african_american'
    if (/\b(hispanic|latino|latina|latinx|latin[\s-]?american)\b/.test(r)) return 'hispanic_latino'
    if (/\b(native[\s-]?american|american indian|alaska native|indigenous|tribal)\b/.test(r)) return 'native_american'
    if (/\b(asian[\s-]?american|asian|pacific islander)\b/.test(r)) return 'asian_american'
    if (/\b(white|caucasian|european[\s-]?american)\b/.test(r)) return 'white'
    return null
  }
  let ethnicityBucket = _ethnicityBucketFromText(ethnicity)

  // -- Household children signal --
  const householdSection = profileSections?.household_details ?? null
  let householdHasChildren = false
  let householdSize = 0
  if (householdSection) {
    const hha = householdSection.answers ?? householdSection
    if (hha && typeof hha === 'object') {
      householdSize = Number(hha.household_size ?? 0)
    }
  }
  if (familySection) {
    const fa = familySection.answers ?? familySection
    if (fa && typeof fa === 'object') {
      householdHasChildren = Boolean(fa.has_children) || Number(fa.number_of_children ?? 0) > 0
    }
  }

  // -- Refugee/immigrant signal --
  let isRefugee = false
  const immigrationSection = profileSections?.immigration ?? null
  if (immigrationSection) {
    const ia = immigrationSection.answers ?? immigrationSection
    if (ia && typeof ia === 'object') {
      isRefugee = Boolean(ia.is_refugee) || Boolean(ia.refugee_status)
    }
  }

  // -- Domestic-violence-survivor / agricultural-producer signals (2026-07-06) --
  // No dedicated profile section exists for either trait, so scan the whole
  // section blob (bounded). ADDITIVE-ONLY consumers: these grant eligibility
  // for survivor-/farmer-restricted programs and keep DV/agriculture programs
  // from being capped for profiles that carry the signal — a false negative
  // degrades to REVIEW (missing field), never a wrong hard-reject.
  let _profileTraitBlob = ''
  try {
    _profileTraitBlob = JSON.stringify(profileSections ?? {}).slice(0, 40000).toLowerCase()
  } catch { _profileTraitBlob = '' }
  const isDvSurvivor =
    /domestic violence|intimate partner violence|family violence|abusive relationship|dv survivor|fleeing abuse/.test(_profileTraitBlob)
  const isFarmer =
    /\bfarm(?:er|ers|ing)?\b|\branch(?:er|ers|ing)\b|agricultural (?:producer|cooperative|operation)|\blivestock\b|\bcrop(?:s|land)?\b/.test(_profileTraitBlob)

  // ---------------------------------------------------------------------------
  // Demographics: traits from demographics section
  // ---------------------------------------------------------------------------
  const demographics = []
  if (demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da && typeof da === 'object') {
      if (da.african_american || da.black) demographics.push('african_american')
      if (da.hispanic_latino || da.hispanic || da.latino) demographics.push('hispanic_latino')
      if (da.asian_american || da.asian) demographics.push('asian_american')
      if (da.native_american || da.indigenous) demographics.push('native_american')
      if (da.lgbtq) demographics.push('lgbtq')
      if (da.first_generation) demographics.push('first_generation')
      if (da.tribal_affiliation) demographics.push('tribal_affiliation')
      if (da.immigrant_status && da.immigrant_status !== 'unknown' && da.immigrant_status !== 'us_citizen') {
        demographics.push('immigrant')
      }
    }
  }
  // Age-derived demographics — only when age is explicitly provided
  if (age !== null && age !== undefined) {
    const numericAge = Number(age)
    if (Number.isFinite(numericAge) && numericAge > 0) {
      if (numericAge < 18) demographics.push('youth')
      if (numericAge >= 18 && numericAge <= 24) demographics.push('young_adult')
      if (numericAge >= 55) demographics.push('senior')
    }
  }
  if (isStudent && !demographics.includes('first_generation')) {
    const ea = (educationSection?.answers ?? educationSection)
    if (ea?.first_generation || ea?.first_generation_college_student) demographics.push('first_generation')
  }

  // Fallback: derive the ethnicity bucket from the boolean demographics tokens
  // when no free-text ethnicity was provided.
  if (!ethnicityBucket) {
    if (demographics.includes('african_american')) ethnicityBucket = 'african_american'
    else if (demographics.includes('hispanic_latino')) ethnicityBucket = 'hispanic_latino'
    else if (demographics.includes('native_american') || demographics.includes('tribal_affiliation')) ethnicityBucket = 'native_american'
    else if (demographics.includes('asian_american')) ethnicityBucket = 'asian_american'
  }

  // ---------------------------------------------------------------------------
  // Gender
  // ---------------------------------------------------------------------------
  const basicInfo = profileSections?.basic_information
  let gender = null
  if (basicInfo) {
    const ba = basicInfo.answers ?? basicInfo
    if (ba?.gender && typeof ba.gender === 'string') gender = ba.gender.toLowerCase()
  }
  if (!gender && demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da?.gender && typeof da.gender === 'string') gender = da.gender.toLowerCase()
  }

  // ---------------------------------------------------------------------------
  // Affiliations: church, school, tribal, first_responder, veteran org, etc.
  // ---------------------------------------------------------------------------
  const affiliations = []
  if (rawTypeLower.includes('church') || rawTypeLower.includes('ministry') || rawTypeLower.includes('faith')) {
    affiliations.push('church', 'faith_based')
  }
  if (rawTypeLower.includes('school') || rawTypeLower.includes('education') || rawTypeLower.includes('k12')) {
    affiliations.push('school')
  }
  if (rawTypeLower.includes('fire') || rawTypeLower.includes('ems') || rawTypeLower.includes('rescue')) {
    affiliations.push('first_responder')
  }
  if (rawTypeLower.includes('tribal') || rawTypeLower.includes('indigenous')) {
    affiliations.push('tribal')
  }
  if (isVeteran) affiliations.push('veteran')
  if (isNonprofit && affiliations.length === 0) affiliations.push('nonprofit')
  // Organization section may declare faith_based, first_responder, tribal, etc.
  // Also consider organization_type inside the section — callers often set
  // `primary_type: 'nonprofit'` and then specialize via organization_details.
  const orgDetailsForAffil = profileSections?.organization_details
  if (orgDetailsForAffil) {
    const od = orgDetailsForAffil.answers ?? orgDetailsForAffil
    const orgTypeLower = String(od?.organization_type || '').toLowerCase()
    if (od?.is_faith_based || od?.faith_based) {
      if (!affiliations.includes('faith_based')) affiliations.push('faith_based')
      if (!affiliations.includes('church')) affiliations.push('church')
    }
    if (od?.is_tribal_government) {
      if (!affiliations.includes('tribal')) affiliations.push('tribal')
    }
    // First-responder-style orgs: VFDs, EMS, rescue squads, police depts,
    // whether declared via organization_type or an explicit boolean flag.
    if (
      od?.first_responder ||
      od?.is_first_responder ||
      orgTypeLower.includes('fire') ||
      orgTypeLower.includes('ems') ||
      orgTypeLower.includes('rescue') ||
      orgTypeLower.includes('police') ||
      orgTypeLower.includes('law_enforcement') ||
      orgTypeLower.includes('emergency')
    ) {
      if (!affiliations.includes('first_responder')) affiliations.push('first_responder')
    }
    if (orgTypeLower.includes('school') || orgTypeLower.includes('k12') || orgTypeLower.includes('education')) {
      if (!affiliations.includes('school')) affiliations.push('school')
    }
    if (orgTypeLower.includes('church') || orgTypeLower.includes('ministry') || orgTypeLower.includes('faith')) {
      if (!affiliations.includes('church')) affiliations.push('church')
      if (!affiliations.includes('faith_based')) affiliations.push('faith_based')
    }
  }

  // ---------------------------------------------------------------------------
  // Geographic qualifiers: rural, appalachian, tribal, urban_underserved, frontier
  // ---------------------------------------------------------------------------
  const geographicQualifiers = []
  const locFocus = profileSections?.location_focus
  if (locFocus) {
    const lfa = locFocus.answers ?? locFocus
    if (lfa && typeof lfa === 'object') {
      if (lfa.rural_resident || lfa.rural) geographicQualifiers.push('rural')
      if (lfa.appalachian_region || lfa.appalachian) geographicQualifiers.push('appalachian')
      if (lfa.tribal_land) geographicQualifiers.push('tribal')
      if (lfa.urban_underserved) geographicQualifiers.push('urban_underserved')
      if (lfa.frontier_community) geographicQualifiers.push('frontier')
    }
  }

  // ---------------------------------------------------------------------------
  // Academics: GPA, ACT, SAT from education section
  // ---------------------------------------------------------------------------
  const academics = { gpa: null, act: null, sat: null }
  if (educationSection) {
    const ea = educationSection.answers ?? educationSection
    if (ea && typeof ea === 'object') {
      const gpaVal = Number(ea.gpa)
      if (Number.isFinite(gpaVal) && gpaVal > 0) academics.gpa = gpaVal
      const actVal = Number(ea.act_score ?? ea.act)
      if (Number.isFinite(actVal) && actVal > 0) academics.act = actVal
      const satVal = Number(ea.sat_score ?? ea.sat)
      if (Number.isFinite(satVal) && satVal > 0) academics.sat = satVal
    }
  }

  // ---------------------------------------------------------------------------
  // Talent & extracurricular signals (music, athletics, leadership, arts)
  // Used to boost talent-based scholarship scoring.
  // Sources: education section extracurriculars, profile-level keywords/tags,
  //          and a dedicated activities/extracurriculars section if present.
  // ---------------------------------------------------------------------------
  const MUSIC_KEYWORDS = ['music', 'band', 'orchestra', 'choir', 'chorus', 'flute', 'violin', 'piano',
    'guitar', 'trumpet', 'percussion', 'clarinet', 'saxophone', 'voice', 'singing', 'vocal',
    'musical', 'instrument', 'marching band', 'concert band', 'jazz', 'symphony']
  const ATHLETIC_KEYWORDS = ['sport', 'athlete', 'athletics', 'basketball', 'football', 'soccer',
    'tennis', 'volleyball', 'swimming', 'track', 'cross country', 'baseball', 'softball',
    'wrestling', 'cheerleading', 'dance', 'gymnastic']
  const ART_KEYWORDS = ['art', 'painting', 'drawing', 'sculpture', 'theater', 'drama', 'debate',
    'speech', 'creative writing', 'photography', 'film', 'design']
  const LEADERSHIP_KEYWORDS = ['student council', 'president', 'vice president', 'captain', 'leader',
    'club president', 'treasurer', 'secretary', 'class officer', 'key club', 'nhs', 'honor society']

  function _matchesKeywords(text, keywords) {
    if (!text || typeof text !== 'string') return false
    const lower = text.toLowerCase()
    return keywords.some((k) => lower.includes(k))
  }

  const talentSignals = { music: false, athletics: false, arts: false, leadership: false, raw: [] }

  // Gather raw extracurricular/activity text from multiple section candidates
  const activitySections = [
    educationSection,
    profileSections?.activities,
    profileSections?.extracurriculars,
    profileSections?.extracurricular_activities,
    profileSections?.talents,
  ].filter(Boolean)

  for (const sec of activitySections) {
    const sa = sec.answers ?? sec
    if (!sa || typeof sa !== 'object') continue
    // Array field: extracurriculars: ["flute", "marching band"]
    const rawActivities = [
      ...safeParseArray(sa.extracurriculars),
      ...safeParseArray(sa.activities),
      ...safeParseArray(sa.leadership_roles),
      ...safeParseArray(sa.clubs),
      ...safeParseArray(sa.sports),
      ...safeParseArray(sa.instruments),
      ...safeParseArray(sa.talents),
    ].map((v) => String(v || '').toLowerCase()).filter(Boolean)

    talentSignals.raw.push(...rawActivities)

    // Also check free-text fields
    for (const fld of ['extracurricular_text', 'activities_text', 'talent_description', 'special_skills']) {
      if (typeof sa[fld] === 'string' && sa[fld].trim()) {
        talentSignals.raw.push(sa[fld].toLowerCase())
      }
    }
  }

  // Check profile-level tags and keywords for talent signals
  const profileTagText = [
    ...safeParseArray(profile.tags),
    ...safeParseArray(profile.keywords),
  ].map((v) => String(v || '').toLowerCase()).join(' ')
  if (profileTagText) talentSignals.raw.push(profileTagText)

  for (const item of talentSignals.raw) {
    if (_matchesKeywords(item, MUSIC_KEYWORDS)) talentSignals.music = true
    if (_matchesKeywords(item, ATHLETIC_KEYWORDS)) talentSignals.athletics = true
    if (_matchesKeywords(item, ART_KEYWORDS)) talentSignals.arts = true
    if (_matchesKeywords(item, LEADERSHIP_KEYWORDS)) talentSignals.leadership = true
  }

  // ---------------------------------------------------------------------------
  // Individual faith signals (for non-org profiles: church attendance, religious affiliation)
  // These are distinct from the org-level faith_based affiliation.
  // ---------------------------------------------------------------------------
  let hasFaithIndicator = false
  const faithSectionCandidates = [
    profileSections?.faith,
    profileSections?.religion,
    profileSections?.religious_affiliation,
    profileSections?.church_membership,
    profileSections?.basic_information,
    profileSections?.personal_information,
    profileSections?.lifestyle,
  ].filter(Boolean)

  for (const sec of faithSectionCandidates) {
    const fa = sec.answers ?? sec
    if (!fa || typeof fa !== 'object') continue
    if (
      Boolean(fa.church_member) || Boolean(fa.faith_affiliation) ||
      Boolean(fa.religious_affiliation) || Boolean(fa.is_christian) ||
      Boolean(fa.is_religious) || Boolean(fa.attends_church) ||
      (typeof fa.religion === 'string' && fa.religion.trim().length > 0 && fa.religion.toLowerCase() !== 'none') ||
      (typeof fa.denomination === 'string' && fa.denomination.trim().length > 0) ||
      (typeof fa.faith === 'string' && fa.faith.trim().length > 0 && fa.faith.toLowerCase() !== 'none')
    ) {
      hasFaithIndicator = true
    }
  }
  // Org-level faith affiliations also count for individual faith indicator
  if (affiliations.includes('faith_based') || affiliations.includes('church')) hasFaithIndicator = true
  // Check profile tags for faith keywords
  const faithKeywords = ['christian', 'catholic', 'protestant', 'baptist', 'methodist', 'lutheran',
    'presbyterian', 'evangelical', 'pentecostal', 'church', 'faith', 'religious', 'mosque', 'synagogue']
  for (const tag of safeParseArray(profile.tags).concat(safeParseArray(profile.keywords))) {
    if (faithKeywords.some((k) => String(tag || '').toLowerCase().includes(k))) hasFaithIndicator = true
  }

  // ---------------------------------------------------------------------------
  // Financial: income, poverty, need level
  // ---------------------------------------------------------------------------
  const financial = { householdIncome: null, belowPovertyLine: false, needLevel: null }
  if (financialSection) {
    const fa = financialSection.answers ?? financialSection
    if (fa && typeof fa === 'object') {
      const monthlyIncome = Number(fa.monthly_income ?? fa.income ?? 0)
      const annualIncome = Number(fa.annual_income ?? fa.household_income ?? 0)
      if (annualIncome > 0) financial.householdIncome = annualIncome
      else if (monthlyIncome > 0) financial.householdIncome = monthlyIncome * 12
      financial.needLevel = fa.financial_need_level ?? null
      financial.belowPovertyLine = Boolean(
        fa.is_low_income || fa.financial_hardship || fa.receives_benefits ||
        fa.below_poverty_line === true || fa.below_poverty_line === 'yes' ||
        (financial.householdIncome > 0 && financial.householdIncome < 24000)
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Occupation signals
  // ---------------------------------------------------------------------------
  const occupation = []
  const occSection = profileSections?.occupation
  if (occSection) {
    const oc = occSection.answers ?? occSection
    if (oc && typeof oc === 'object') {
      if (oc.job_title) occupation.push(String(oc.job_title).toLowerCase())
      if (oc.industry) occupation.push(String(oc.industry).toLowerCase())
      if (oc.healthcare_worker_type) occupation.push(String(oc.healthcare_worker_type).toLowerCase())
    }
  }

  // ---------------------------------------------------------------------------
  // Assistance flags: enrolled programs + additional assistance indicators
  // ---------------------------------------------------------------------------
  const assistanceFlags = [...enrolledPrograms]
  if (financial.belowPovertyLine && !assistanceFlags.includes('low_income')) assistanceFlags.push('low_income')
  if (hasEmploymentNeed && !assistanceFlags.includes('unemployed')) {
    const empa = (employmentSection?.answers ?? employmentSection)
    if (empa?.unemployed || String(empa?.employment_status ?? '').toLowerCase().includes('unemployed')) {
      assistanceFlags.push('unemployed')
    }
  }

  // ---------------------------------------------------------------------------
  // Immigration status (enriched beyond isRefugee)
  // ---------------------------------------------------------------------------
  let immigrationStatus = null
  if (immigrationSection) {
    const ia = immigrationSection.answers ?? immigrationSection
    if (ia && typeof ia === 'object') {
      immigrationStatus = ia.immigrant_status ?? ia.immigration_status ?? null
    }
  }
  if (!immigrationStatus && demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da?.immigrant_status && da.immigrant_status !== 'unknown') {
      immigrationStatus = da.immigrant_status
    }
  }

  // ---------------------------------------------------------------------------
  // RC-17: Document-derived signals
  //
  // documents.extracted_text is the parsed-plaintext output from PDF / DOCX
  // / image OCR ingestion (see backend/services/documentIngestion.js). When
  // a user uploads a benefits letter, IEP, eviction notice, etc., we can
  // cheaply check whether the text mentions any keyword in the canonical
  // need vocabulary. We never create new need buckets — only canonical
  // values from NEED_ALIAS_MAP can come out of this scan, so a noisy or
  // adversarial document cannot pollute the matcher.
  // ---------------------------------------------------------------------------
  const _docText = _coerceDocumentsToText(
    documents ?? rawProfile?.documents ?? null,
  )
  const documentSignals = _docText
    ? extractNeedSignalsFromDocumentText(_docText)
    : []
  for (const docNeed of documentSignals) {
    if (!needCategories.includes(docNeed)) needCategories.push(docNeed)
  }

  // ---------------------------------------------------------------------------
  // Soft inference: ensure no profile produces empty needCategories
  // ---------------------------------------------------------------------------
  if (needCategories.length === 0) {
    // Infer from boolean flags first
    if (isVeteran) needCategories.push('veteran')
    if (isStudent) needCategories.push('education')
    if (isBusiness) needCategories.push('business')
    if (isNonprofit) needCategories.push('nonprofit_ministry')
    if (isCaregiver) needCategories.push('family_life')
    if (hasDisabilityNeed) needCategories.push('disability')
    if (hasEmergencyNeed) needCategories.push('emergency')
    if (hasHousingNeed) needCategories.push('housing')
    if (hasEmploymentNeed) needCategories.push('employment')
    if (isRefugee) needCategories.push('emergency')
    if (financial.belowPovertyLine) {
      if (!needCategories.includes('food')) needCategories.push('food')
      if (!needCategories.includes('utilities')) needCategories.push('utilities')
    }
  }
  // If STILL empty after flag inference, derive from entity type alone
  if (needCategories.length === 0) {
    const typeInference = {
      individual: ['cash_assistance', 'housing', 'food'],
      student: ['education'],
      veteran: ['veteran'],
      nonprofit: ['nonprofit_ministry'],
      business: ['business'],
      caregiver: ['family_life'],
      researcher: ['research_arts'],
      artist: ['research_arts'],
      organization: ['nonprofit_ministry'],
    }
    const inferred = typeInference[entityType]
    if (inferred) {
      needCategories.push(...inferred)
    } else {
      // Absolute fallback: every profile gets baseline needs
      needCategories.push('cash_assistance')
    }
  }

  // ---------------------------------------------------------------------------
  // Structured business / ownership / organization / population / mission data.
  //
  // These fields are what actually determines eligibility for the bulk of
  // business, nonprofit, church, school, and volunteer-fire funding
  // opportunities (SBA set-asides, WOSB, SDVOSB, CDFI, HBCU, USDA rural, NIH
  // for nonprofits, NEA for arts, population-served mandates, etc.). They
  // were previously only available as loose keywords on profileSignals and
  // therefore invisible to matchEngine's hard-eligibility + scoring paths.
  // Every downstream consumer (matchEngine, relevanceFilter, Anya) reads
  // these through the normalized profile.
  // ---------------------------------------------------------------------------
  const _asBoolNullable = asBoolNullable
  const _parseNumber = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.+-]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  const _str = (v) =>
    typeof v === 'string' && hasSpecificTextValue(v) ? v.trim() : null

  const _orgDetailsSection =
    profileSections?.organization_details?.answers ??
    profileSections?.organization_details ??
    {}
  const _programsSection =
    profileSections?.programs_services?.answers ??
    profileSections?.programs_services ??
    {}
  const _businessSection =
    profileSections?.small_business_details?.answers ??
    profileSections?.small_business_details ??
    profileSections?.business?.answers ??
    profileSections?.business ??
    {}
  const _locationSection =
    profileSections?.location_focus?.answers ??
    profileSections?.location_focus ??
    {}
  const _narrativeSection =
    profileSections?.narrative?.answers ??
    profileSections?.narrative ??
    {}

  const _certsRaw = Array.isArray(_businessSection.certifications)
    ? _businessSection.certifications.map((c) => String(c).toLowerCase().trim()).filter(Boolean)
    : []
  const _certSet = new Set(_certsRaw)

  const ownership = {
    isVeteranOwned:
      Boolean(_orgDetailsSection.cert_sdvosb) ||
      _certSet.has('sdvosb') ||
      _certSet.has('service-disabled veteran') ||
      _certSet.has('vosb') ||
      _certSet.has('veteran-owned') ||
      _asBoolNullable(_businessSection.veteran_owned) === true ||
      _asBoolNullable(_orgDetailsSection.veteran_owned) === true,
    isServiceDisabledVeteranOwned:
      Boolean(_orgDetailsSection.cert_sdvosb) ||
      _certSet.has('sdvosb') ||
      _certSet.has('service-disabled veteran'),
    isWomanOwned:
      Boolean(_orgDetailsSection.cert_wbe) ||
      _certSet.has('wbe') ||
      _certSet.has('wosb') ||
      _certSet.has('women-owned') ||
      _asBoolNullable(_businessSection.woman_owned) === true ||
      _asBoolNullable(_orgDetailsSection.woman_owned) === true,
    isMinorityOwned:
      Boolean(_orgDetailsSection.cert_mbe) ||
      _certSet.has('mbe') ||
      _certSet.has('minority-owned') ||
      _asBoolNullable(_businessSection.minority_owned) === true ||
      _asBoolNullable(_orgDetailsSection.minority_owned) === true,
    isDisabledOwned:
      _asBoolNullable(_businessSection.disabled_owned) === true ||
      _asBoolNullable(_orgDetailsSection.disabled_owned) === true ||
      Boolean(_orgDetailsSection.cert_sdvosb),
    isLGBTQOwned:
      _asBoolNullable(_businessSection.lgbtq_owned) === true ||
      _asBoolNullable(_orgDetailsSection.lgbtq_owned) === true,
    is8aCertified:
      Boolean(_orgDetailsSection.cert_8a) ||
      _certSet.has('8a') ||
      _certSet.has('8(a)'),
    isHUBZoneCertified:
      Boolean(_orgDetailsSection.cert_hubzone) ||
      _certSet.has('hubzone'),
    isCDFI: Boolean(_orgDetailsSection.is_cdfi),
    isHBCU: Boolean(_orgDetailsSection.is_msi_hbcu),
    isTribalGovernment: Boolean(_orgDetailsSection.is_tribal_government),
    isHousingAuthority: Boolean(_orgDetailsSection.is_housing_authority),
    isCommunityActionAgency: Boolean(_orgDetailsSection.is_community_action_agency),
    isCooperative: Boolean(_orgDetailsSection.is_cooperative),
    isFaithBased: Boolean(_orgDetailsSection.is_faith_based) || affiliations.includes('faith_based'),
    isRuralServing: Boolean(_orgDetailsSection.is_rural_serving),
    isMinorityServing: Boolean(_orgDetailsSection.is_minority_serving),
    samGovRegistered: Boolean(_orgDetailsSection.sam_gov_registered),
    grantsGovAccount: Boolean(_orgDetailsSection.grants_gov_account),
    nicraRate: _parseNumber(_orgDetailsSection.nicra_rate),
  }

  const business = {
    industry:
      _str(_businessSection.industry) ??
      _str(_orgDetailsSection.industry) ??
      null,
    naicsCode:
      _str(_businessSection.naics_code) ??
      _str(_orgDetailsSection.naics_code) ??
      null,
    businessType:
      _str(_businessSection.business_type) ??
      _str(_orgDetailsSection.organization_type) ??
      null,
    employeeCount:
      _parseNumber(_businessSection.employee_count) ??
      _parseNumber(_orgDetailsSection.employee_count) ??
      _parseNumber(_orgDetailsSection.staff_count) ??
      null,
    annualRevenue:
      _parseNumber(_businessSection.annual_revenue) ??
      _parseNumber(_orgDetailsSection.annual_revenue) ??
      _parseNumber(_orgDetailsSection.annual_budget) ??
      null,
    yearsInOperation:
      _parseNumber(_businessSection.years_in_business) ??
      _parseNumber(_businessSection.years_in_operation) ??
      _parseNumber(_orgDetailsSection.years_in_operation) ??
      _parseNumber(_orgDetailsSection.years_operating) ??
      null,
    einPresent: Boolean(_str(_orgDetailsSection.ein) || _str(_businessSection.ein)),
    ueiPresent: Boolean(_str(_orgDetailsSection.uei) || _str(_businessSection.uei)),
    fiscalSponsor: _str(_orgDetailsSection.fiscal_sponsor),
  }

  // "startup" is a widely-used soft signal for funder programs; exposed as a
  // structured flag so matchEngine can boost startup-friendly opportunities
  // without relying on noisy keyword matching.
  business.isStartup =
    business.yearsInOperation !== null && business.yearsInOperation < 3

  business.isMicroEnterprise =
    business.employeeCount !== null && business.employeeCount <= 10

  business.isLowRevenue =
    business.annualRevenue !== null && business.annualRevenue < 250000

  const organization = {
    organizationType:
      _str(_orgDetailsSection.organization_type) ??
      _str(_orgDetailsSection.org_type) ??
      (isNonprofit ? 'nonprofit' : null),
    mission:
      _str(_orgDetailsSection.mission) ??
      _str(_narrativeSection.mission) ??
      null,
    populationServed: (() => {
      const raw =
        _orgDetailsSection.population_served ??
        _orgDetailsSection.target_population ??
        _programsSection.target_population ??
        _narrativeSection.target_population ??
        null
      if (!raw) return []
      if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
      if (typeof raw === 'string') {
        return raw
          .split(/[,;|]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      }
      return []
    })(),
    missionFocus: (() => {
      const focus =
        _orgDetailsSection.mission_focus ??
        _programsSection.focus_areas ??
        _programsSection.mission_focus ??
        null
      if (!focus) return []
      if (Array.isArray(focus)) return focus.map(String).filter(Boolean)
      if (typeof focus === 'string') {
        return focus
          .split(/[,;|]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      }
      return []
    })(),
    nteeCode: _str(_orgDetailsSection.ntee_code),
    isFaithBased: ownership.isFaithBased,
  }

  const country =
    _str(profile.country) ??
    _str(_locationSection.country) ??
    _str(_orgDetailsSection.country) ??
    'US'

  // ── Effective profile FACETS (data-derived) ────────────────────────────────
  // The clicked primary_type is ADVISORY; a profile's real eligibility comes from
  // its DATA. We derive a UNION of facets from the section-derived flags computed
  // above, so a person who is (e.g.) a disabled senior individual is eligible for
  // disability AND senior AND individual funding — regardless of the type they
  // selected, or mis-selected. The matcher consumes these ADDITIVELY: a facet can
  // GRANT eligibility the clicked type would have missed; it never removes a match
  // (recall-safe, per canonical rule G4). When the data is silent, we fall back to
  // the clicked entityType so an empty/new profile still has one eligibility signal.
  const _ageNum = Number(age)
  const _seniorSignal =
    (Number.isFinite(_ageNum) && _ageNum >= 60) ||
    /\b(senior|elder|older adult|6[0-9]\s*\+|7[0-9]\s*\+|8[0-9]\s*\+|retire)\b/i.test(String(resolvedAgeGroup ?? ''))
  const _orgLikeEntity = isNonprofit || isBusiness ||
    ['organization', 'nonprofit', 'business', 'government', 'institution', 'research', 'researcher', 'school'].includes(String(entityType))
  const effectiveFacets = []
  const _addFacet = (facet, on) => { if (on && !effectiveFacets.includes(facet)) effectiveFacets.push(facet) }
  _addFacet('individual', !_orgLikeEntity)
  _addFacet('student', isStudent)
  _addFacet('veteran', isVeteran)
  _addFacet('nonprofit', isNonprofit)
  _addFacet('business', isBusiness)
  _addFacet('caregiver', isCaregiver)
  _addFacet('senior', _seniorSignal)
  _addFacet('disabled', hasDisabilityNeed)
  _addFacet('disaster_survivor', hasEmergencyNeed)
  if (effectiveFacets.length === 0 && entityType) effectiveFacets.push(String(entityType))

  const normalized = {
    id: profile.id,
    entityType,
    // Data-derived eligibility facets (union of facts); see comment above.
    effectiveFacets,
    state,
    // ALL of the profile's states (primary-first, deduped, 2-letter). A
    // single-address profile yields exactly [state]; a multi-address /
    // multi-state profile yields every one so geo matching claims in-state for
    // ANY address. Empty = unknown (neutral, never a penalty).
    states,
    zip,
    county,
    city,
    needCategories,
    // Boolean status flags
    isVeteran,
    isStudent,
    isNonprofit,
    isBusiness,
    isCaregiver,
    hasFosterIndicator,
    hasChronicIllness,
    hasDisabilityNeed,
    // NAMED conditions only (never bare flags/descriptors) — see the health
    // section read above and config/conditionSpecificity.js.
    namedHealthConditions,
    hasEmergencyNeed,
    hasHousingNeed,
    hasEmploymentNeed,
    hasBusinessNeed,
    isUnableToWork,
    isRefugee,
    isDvSurvivor,
    isFarmer,
    // Demographics & identity
    age,
    ageGroup: resolvedAgeGroup,
    gender,
    ethnicity,
    // Canonical ethnicity bucket (african_american / hispanic_latino /
    // native_american / asian_american / white) or null when unknown. Used by
    // the matcher to hard-gate ethnicity-exclusive scholarships ONLY when the
    // profile clearly does not qualify. null ⇒ neutral.
    ethnicityBucket,
    demographics,
    immigrationStatus,
    // Affiliations & qualifiers
    affiliations,
    geographicQualifiers,
    // Structured signal groups
    academics,
    financial,
    occupation,
    // Assistance & household
    enrolledPrograms,
    assistanceFlags,
    householdHasChildren,
    householdSize,
    // Talent & faith signals (housing/scholarship matching)
    talentSignals,
    hasFaithIndicator,
    // Structured business / ownership / organization (full-profile coverage)
    country,
    business,
    ownership,
    organization,
    // Convenient top-level mirrors used throughout matchEngine + Anya
    isVeteranOwned: ownership.isVeteranOwned,
    isWomanOwned: ownership.isWomanOwned,
    isMinorityOwned: ownership.isMinorityOwned,
    isFaithBased: ownership.isFaithBased,
    isTribal: ownership.isTribalGovernment || affiliations.includes('tribal'),
    populationServed: organization.populationServed,
    missionFocus: organization.missionFocus,
    organizationType: organization.organizationType,
    industry: business.industry,
    naicsCode: business.naicsCode,
    employeeCount: business.employeeCount,
    annualRevenue: business.annualRevenue,
    yearsInOperation: business.yearsInOperation,
    // Professional credentials (RN/LCSW/MD/...) inferred via signals.
    // When set, scoring routes to professional_development funder pools
    // (state nursing foundations, ANA/NASW/AMA scholarships, WIOA ITA, etc.)
    // even when the user's free-text query is generic.
    credentials: signals?.credentials instanceof Set
      ? Array.from(signals.credentials)
      : Array.isArray(signals?.credentials) ? signals.credentials : [],
    isLicensedProfessional: Boolean(signals?.isLicensedProfessional)
      || (signals?.credentials instanceof Set && signals.credentials.size > 0),
    // RC-17: traceability for which canonical needs were folded in from
    // uploaded documents.extracted_text. Always an array (possibly empty).
    documentSignals,
    // Display
    displayName: profile.display_name ?? profile.name ?? null,
  }

  return normalized
}

// ---------------------------------------------------------------------------
// Compute a deterministic fingerprint for a normalized profile
// Changes when entity type, location, or need categories change.
// ---------------------------------------------------------------------------
export function computeProfileFingerprint(normalizedProfile) {
  if (!normalizedProfile) return null
  const relevant = {
    entityType: normalizedProfile.entityType,
    state: normalizedProfile.state,
    zip: normalizedProfile.zip,
    needCategories: (normalizedProfile.needCategories ?? []).slice().sort(),
    isVeteran: normalizedProfile.isVeteran,
    isStudent: normalizedProfile.isStudent,
    isNonprofit: normalizedProfile.isNonprofit,
    isBusiness: normalizedProfile.isBusiness,
    isCaregiver: normalizedProfile.isCaregiver,
    hasFosterIndicator: normalizedProfile.hasFosterIndicator,
    hasChronicIllness: normalizedProfile.hasChronicIllness,
    hasDisabilityNeed: normalizedProfile.hasDisabilityNeed,
    hasEmergencyNeed: normalizedProfile.hasEmergencyNeed,
    hasHousingNeed: normalizedProfile.hasHousingNeed,
    hasEmploymentNeed: normalizedProfile.hasEmploymentNeed,
    hasBusinessNeed: normalizedProfile.hasBusinessNeed,
    isRefugee: normalizedProfile.isRefugee,
    householdHasChildren: normalizedProfile.householdHasChildren,
    ageGroup: normalizedProfile.ageGroup,
    enrolledPrograms: (normalizedProfile.enrolledPrograms ?? []).slice().sort(),
    demographics: (normalizedProfile.demographics ?? []).slice().sort(),
    gender: normalizedProfile.gender ?? null,
    affiliations: (normalizedProfile.affiliations ?? []).slice().sort(),
    geographicQualifiers: (normalizedProfile.geographicQualifiers ?? []).slice().sort(),
    assistanceFlags: (normalizedProfile.assistanceFlags ?? []).slice().sort(),
    immigrationStatus: normalizedProfile.immigrationStatus ?? null,
  }
  return createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 16)
}
