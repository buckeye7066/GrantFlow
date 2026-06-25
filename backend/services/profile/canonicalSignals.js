/**
 * canonicalSignals.js
 *
 * THE single canonical profile signal schema for GrantFlow.
 *
 * All profile-signal producers (profileHelpers, profileNormalizer,
 * profileSignals/index) should be converted to / from this shape via the
 * adapter functions below.  Downstream consumers in the matching pipeline
 * MUST use this shape to guarantee consistent field names and collection
 * types.
 *
 * Key design decisions:
 *  - All collections are Arrays (never Sets).
 *  - Consistent field naming: `applicantTypes` (Array), `location.zipCode`,
 *    `financial.annualBudget`, `financial.requestedAmount`,
 *    `organization.orgType`, `organization.orgSize`, `organization.einNumber`.
 *  - Handles null / missing / inconsistent inputs gracefully; never throws.
 */

import { buildProfileSignals } from '../profileHelpers.js'
import { createLogger } from '../../utils/logger.js'
const qualityLog = createLogger('services:profile:canonicalSignals')

// ---------------------------------------------------------------------------
// Type documentation (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CanonicalLocation
 * @property {string|null} state    - 2-letter state abbreviation (upper-case)
 * @property {string|null} county   - County name
 * @property {string|null} city     - City name
 * @property {string|null} zipCode  - 5-digit ZIP code string (canonical; legacy `zip` is accepted on input)
 */

/**
 * @typedef {Object} CanonicalFinancial
 * @property {number|null} householdIncome  - Annual household income (individuals)
 * @property {number|null} annualBudget     - Annual operating budget (organizations)
 * @property {number|null} householdSize    - Number of people in household
 * @property {string|null} needLevel        - Qualitative need level descriptor
 * @property {number|null} requestedAmount  - Funding amount being sought
 */

/**
 * @typedef {Object} CanonicalOrganization
 * @property {string|null} orgType       - Canonical organization type string
 * @property {string|null} orgSize       - Organization size descriptor
 * @property {string|null} einNumber     - EIN / tax-ID number (canonical; legacy `ein` accepted on input)
 * @property {string|null} uei           - UEI (SAM.gov unique entity identifier)
 * @property {string|null} naicsCode     - Primary NAICS code
 * @property {boolean}     is501c3       - Whether org is a 501(c)(3) nonprofit
 * @property {boolean}     samRegistered - Whether org is SAM.gov registered
 * @property {boolean}     faithBased    - Whether org is faith-based
 */

/**
 * @typedef {Object} CanonicalSignals
 * @property {string}               applicantType    - Single resolved applicant type ('individual'|'organization'|'student'|…)
 * @property {string[]}             applicantTypes   - All detected applicant-type tokens (Array)
 * @property {CanonicalLocation}    location         - Standardized geographic location
 * @property {string[]}             needs            - Need category tokens
 * @property {string[]}             keywords         - Flat keyword list
 * @property {string[]}             phrases          - Multi-word phrases
 * @property {string[]}             intentPhrases    - High-priority goal / intent phrases
 * @property {string[]}             demographics     - Demographic tokens
 * @property {string[]}             genders          - Gender tokens
 * @property {string[]}             health           - Health condition tokens
 * @property {string[]}             family           - Family situation tokens
 * @property {string[]}             military         - Military / veteran tokens
 * @property {string[]}             occupation       - Occupation / career tokens
 * @property {string[]}             immigration      - Immigration status tokens
 * @property {string[]}             geographic       - Geographic qualifier tokens
 * @property {string[]}             assistance       - Government assistance program tokens
 * @property {string[]}             interests        - Interest / hobby tokens
 * @property {string[]}             sports           - Sport tokens
 * @property {string[]}             proBonoTerms     - Pro-bono related tokens
 * @property {CanonicalFinancial}   financial        - Financial signals
 * @property {CanonicalOrganization} organization    - Organization-level signals
 * @property {Object}               education        - Education signals object (level, currentSchool, targetColleges, etc.)
 * @property {{ gpa: number|null, act: number|null, sat: number|null, psat: number|null, [key: string]: * }} academics - Academic performance. Core keys are gpa/act/sat/psat; additional keys may be present.
 * @property {any[]}                schools          - School / university targets
 * @property {Object}               coverage         - Signal coverage metadata
 * @property {Object}               rawSections      - Raw section data passthrough
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert any collection (Set, Array, null, undefined) to a deduplicated
 * Array of non-empty strings.
 *
 * @param {Set|Array|*} collection
 * @returns {string[]}
 */
function toArray(collection) {
  if (!collection) return []
  const iterable =
    collection instanceof Set
      ? collection
      : Array.isArray(collection)
        ? collection
        : [collection]
  const result = []
  const seen = new Set()
  for (const item of iterable) {
    if ((item === null || item === undefined) || item === '') continue
    const s = String(item)
    if (!seen.has(s)) {
      seen.add(s)
      result.push(s)
    }
  }
  return result
}

/**
 * Build a safe CanonicalLocation from various input shapes.
 *
 * @param {Object} raw
 * @returns {CanonicalLocation}
 */
function normalizeLocation(raw) {
  if (!raw || typeof raw !== 'object') {
    return { state: null, county: null, city: null, zipCode: null }
  }
  const rawState = raw.state ?? null
  const rawZip = raw.zipCode ?? raw.zip ?? null
  return {
    state: rawState && typeof rawState === 'string' ? rawState.trim().toUpperCase().slice(0, 2) || null : null,
    county: raw.county ?? null,
    city: raw.city ?? null,
    zipCode: rawZip && typeof rawZip === 'string' ? rawZip.trim().replace(/\D/g, '').slice(0, 5) || null : null,
  }
}

/**
 * Build a safe CanonicalFinancial from various input shapes.
 *
 * @param {Object} raw
 * @param {Object} [orgSection]
 * @returns {CanonicalFinancial}
 */
function normalizeFinancial(raw, orgSection = {}) {
  if (!raw || typeof raw !== 'object') raw = {}
  const householdIncome =
    raw.householdIncome ?? raw.household_income ?? raw.income ?? null
  const annualBudget =
    raw.annualBudget ??
    raw.annual_budget ??
    raw.budget ??
    raw.organizationBudget ??
    raw.organization_budget ??
    (orgSection?.annual_budget ?? null)
  const requestedAmount =
    raw.requestedAmount ??
    raw.requested_amount ??
    raw.fundingAmountNeeded ??
    raw.funding_amount_needed ??
    null
  return {
    householdIncome:
      householdIncome !== null ? (Number(householdIncome) || null) : null,
    annualBudget:
      annualBudget !== null ? (Number(annualBudget) || null) : null,
    householdSize: raw.householdSize ?? raw.household_size ?? null,
    needLevel: raw.needLevel ?? raw.need_level ?? null,
    requestedAmount:
      requestedAmount !== null ? (Number(requestedAmount) || null) : null,
  }
}

/**
 * Build a safe CanonicalOrganization from various input shapes.
 *
 * @param {Object} raw
 * @param {Object} [orgSection]
 * @returns {CanonicalOrganization}
 */
function normalizeOrganization(raw, orgSection = {}) {
  if (!raw || typeof raw !== 'object') raw = {}
  return {
    orgType:
      raw.orgType ??
      raw.org_type ??
      orgSection?.organization_type ??
      orgSection?.org_type ??
      null,
    orgSize:
      raw.orgSize ??
      raw.org_size ??
      orgSection?.organization_size ??
      orgSection?.org_size ??
      null,
    // Canonical: einNumber (legacy: ein)
    einNumber: raw.einNumber ?? raw.ein_number ?? raw.ein ?? orgSection?.ein ?? null,
    uei: raw.uei ?? orgSection?.uei ?? null,
    naicsCode: raw.naicsCode ?? raw.naics_code ?? orgSection?.naics_code ?? null,
    is501c3: Boolean(raw.is501c3 ?? raw.is_501c3 ?? orgSection?.is_501c3),
    samRegistered: Boolean(
      raw.samRegistered ?? raw.sam_registered ?? orgSection?.sam_registered,
    ),
    faithBased: Boolean(raw.faithBased ?? raw.faith_based ?? orgSection?.faith_based),
  }
}

// ---------------------------------------------------------------------------
// Empty / zero-signal baseline
// ---------------------------------------------------------------------------

/**
 * Return an empty (zero-signal) canonical shape.
 * Used as a safe fallback when no profile data is available.
 *
 * @returns {CanonicalSignals}
 */
export function emptyCanonicalSignals() {
  return {
    applicantType: 'individual',
    applicantTypes: [],
    location: { state: null, county: null, city: null, zipCode: null },
    needs: [],
    keywords: [],
    phrases: [],
    intentPhrases: [],
    demographics: [],
    genders: [],
    health: [],
    family: [],
    military: [],
    occupation: [],
    immigration: [],
    geographic: [],
    assistance: [],
    interests: [],
    sports: [],
    proBonoTerms: [],
    financial: {
      householdIncome: null,
      annualBudget: null,
      householdSize: null,
      needLevel: null,
      requestedAmount: null,
    },
    organization: {
      orgType: null,
      orgSize: null,
      einNumber: null,
      uei: null,
      naicsCode: null,
      is501c3: false,
      samRegistered: false,
      faithBased: false,
    },
    education: {},
    academics: { gpa: null, act: null, sat: null, psat: null },
    schools: [],
    coverage: { pct: 0, sections_present: 0, sections_expected: 0 },
    rawSections: {},
  }
}

// ---------------------------------------------------------------------------
// Adapters / converters
// ---------------------------------------------------------------------------

/**
 * Convert the output of `buildProfileSignals()` (from profileHelpers.js)
 * to the canonical signal shape.
 *
 * `buildProfileSignals()` returns Sets for most collections; this normalises
 * all of them to Arrays and standardises field names.
 *
 * @param {Object} signals - Return value of buildProfileSignals()
 * @returns {CanonicalSignals}
 */
export function fromLegacyHelpers(signals) {
  if (!signals || typeof signals !== 'object') return emptyCanonicalSignals()

  return {
    applicantType: signals.applicantType ?? 'individual',
    applicantTypes: toArray(signals.applicantTypes),
    location: normalizeLocation(signals.location),
    needs: toArray(signals.needs),
    // keywords is already an Array in buildProfileSignals; fall back to keywordSet
    keywords: Array.isArray(signals.keywords)
      ? signals.keywords
      : toArray(signals.keywordSet),
    phrases: toArray(signals.phrases),
    intentPhrases: toArray(signals.intentPhrases),
    demographics: toArray(signals.demographics),
    genders: toArray(signals.genders),
    health: toArray(signals.health),
    family: toArray(signals.family),
    military: toArray(signals.military),
    occupation: toArray(signals.occupation),
    immigration: toArray(signals.immigration),
    geographic: toArray(signals.geographic),
    assistance: toArray(signals.assistance),
    interests: toArray(signals.interests),
    sports: toArray(signals.sports),
    proBonoTerms: toArray(signals.proBonoTerms),
    financial: normalizeFinancial(signals.financial),
    organization: normalizeOrganization(signals.organization),
    education:
      signals.education && typeof signals.education === 'object'
        ? signals.education
        : {},
    academics:
      signals.academics && typeof signals.academics === 'object'
        ? signals.academics
        : { gpa: null, act: null, sat: null, psat: null },
    schools: Array.isArray(signals.schools) ? signals.schools : [],
    coverage:
      signals.coverage && typeof signals.coverage === 'object'
        ? signals.coverage
        : {},
    rawSections:
      signals.rawSections && typeof signals.rawSections === 'object'
        ? signals.rawSections
        : {},
  }
}

/**
 * Convert the output of `normalizeProfile()` (from profileNormalizer.js)
 * to the canonical signal shape.
 *
 * `normalizeProfile()` returns a flat structure with top-level
 * state / zip / city and `needCategories` as an Array of strings.
 *
 * @param {Object} normalized - Return value of normalizeProfile()
 * @returns {CanonicalSignals}
 */
export function fromNormalizer(normalized) {
  if (!normalized || typeof normalized !== 'object') return emptyCanonicalSignals()

  const location = normalizeLocation({
    state: normalized.state ?? null,
    county: normalized.county ?? null,
    city: normalized.city ?? null,
    zip: normalized.zip ?? normalized.postal_code ?? null,
  })

  const needCategories = toArray([
    ...(Array.isArray(normalized.needCategories) ? normalized.needCategories : []),
    ...(Array.isArray(normalized.needs) ? normalized.needs : []),
  ])
  const entityType = normalized.entityType ?? 'individual'

  // Merge boolean-flag shortcuts WITH any richer tokens already present
  const militaryBase = normalized.isVeteran ? ['veteran'] : []
  const military = toArray([...militaryBase, ...(normalized.military ?? [])])

  const demographicsBase = []
  if (normalized.isStudent) demographicsBase.push('student')
  if (normalized.hasChronicIllness) demographicsBase.push('disability')
  const demographics = toArray([...demographicsBase, ...(normalized.demographics ?? [])])

  return {
    applicantType: entityType,
    applicantTypes: [...new Set([entityType, ...toArray(normalized.applicantTypes)])],
    location,
    needs: needCategories,
    keywords: toArray(normalized.keywords),
    phrases: toArray(normalized.phrases),
    intentPhrases: toArray(normalized.intentPhrases),
    demographics,
    genders: toArray(normalized.genders),
    health: toArray(normalized.health),
    family: toArray(normalized.family),
    military,
    occupation: toArray(normalized.occupation),
    immigration: toArray(normalized.immigration),
    geographic: toArray(normalized.geographic),
    assistance: toArray(normalized.assistance),
    interests: toArray(normalized.interests),
    sports: toArray(normalized.sports),
    proBonoTerms: toArray(normalized.proBonoTerms),
    financial: normalizeFinancial(normalized.financial ?? {}),
    organization: normalizeOrganization(normalized.organization ?? {}),
    education:
      normalized.education && typeof normalized.education === 'object'
        ? normalized.education
        : {},
    academics:
      normalized.academics && typeof normalized.academics === 'object'
        ? normalized.academics
        : { gpa: null, act: null, sat: null, psat: null },
    schools: Array.isArray(normalized.schools) ? normalized.schools : [],
    coverage:
      normalized.coverage && typeof normalized.coverage === 'object'
        ? normalized.coverage
        : { pct: 0, sections_present: 0, sections_expected: 0 },
    rawSections: normalized.rawSections ?? {},
  }
}

/**
 * Convert the output of `toAnalysisShape()` (from profileSignals/index.js)
 * to the canonical signal shape.
 *
 * `toAnalysisShape()` is a thin adapter over `buildProfileSignals` signals,
 * so Set-vs-Array treatment is the same as `fromLegacyHelpers`.
 * The only difference is the financial object is exposed as `income` instead
 * of `financial`.
 *
 * @param {Object} analysis - Return value of toAnalysisShape()
 * @returns {CanonicalSignals}
 */
export function fromAnalysisShape(analysis) {
  if (!analysis || typeof analysis !== 'object') return emptyCanonicalSignals()

  // toAnalysisShape renames 'financial' → 'income'; map it back before
  // delegating to fromLegacyHelpers.
  const mergedFinancial =
    analysis.financial && typeof analysis.financial === 'object' && Object.keys(analysis.financial).length > 0
      ? analysis.financial
      : (analysis.income && typeof analysis.income === 'object' ? analysis.income : {})
  const normalised = {
    ...analysis,
    financial: mergedFinancial,
  }
  return fromLegacyHelpers(normalised)
}

// ---------------------------------------------------------------------------
// Primary builder
// ---------------------------------------------------------------------------

/**
 * Build canonical signals directly from a raw profile object (and optional
 * sections).
 *
 * This is the RECOMMENDED entry point when you have a raw profile row (or an
 * object that looks like one).  It delegates to `buildProfileSignals()` for the
 * heavy extraction work and then normalises the result to the canonical shape.
 *
 * @param {Object} rawProfile  - Profile row or `{ profile, sections }` envelope
 * @param {Object} [rawSections] - Profile sections (keyed by section_key).
 *   Ignored when rawProfile is a `{ profile, sections }` envelope.
 * @returns {CanonicalSignals}
 */
export function buildCanonicalSignals(rawProfile, rawSections = {}) {
  if (!rawProfile) return emptyCanonicalSignals()

  // Accept either a plain profile row or a { profile, sections } envelope
  const profile = rawProfile?.profile ?? rawProfile
  const sections = rawProfile?.sections ?? rawSections ?? {}

  try {
    const legacySignals = buildProfileSignals({ profile, sections })
    return fromLegacyHelpers(legacySignals)
  } catch (error) {
    qualityLog.error('Failed to build canonical signals:', error)
    return emptyCanonicalSignals()
  }
}

export default {
  buildCanonicalSignals,
  fromLegacyHelpers,
  fromNormalizer,
  fromAnalysisShape,
  emptyCanonicalSignals,
}
