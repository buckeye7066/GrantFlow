/**
 * Profile coverage / completeness utility.
 *
 * Purpose (mission-audit-driven):
 *   The audit flagged that several canonical profile sections were being
 *   silently dropped when missing (basic_information, organization_details,
 *   location_focus, programs_services, funding_needs, financial_information,
 *   comprehensive_application) and that discrete fields such as country,
 *   employee_count, annual_revenue, years_in_operation, veteran_owned,
 *   woman_owned, minority_owned, organization_type, population_served, and
 *   mission_focus weren't being surfaced consistently to the matcher or to
 *   Anya.
 *
 *   This module provides a single, pure function that:
 *     - Accepts a normalized profile (from profileNormalizer.normalizeProfile)
 *     - Accepts the raw profile sections map (so we can tell "section present
 *       but empty" from "section missing entirely")
 *     - Returns a coverage object with:
 *         { coverage: 0..1, completeness, fieldSignals, sectionSignals,
 *           missingSections, missingFields, covered, suggestions, summary }
 *
 *   The coverage object is:
 *     - Stable (deterministic given same input)
 *     - Explainable (each signal has a label and a weight)
 *     - Safe defaults (missing fields reduce score, they never throw or
 *       disqualify an opportunity — aligned with user rules "Profile
 *       attributes should increase score, not eliminate results").
 *
 * Used by:
 *   - matchEngine.scoreOpportunity — to surface `profileSignalsUsed` in
 *     match_explain so Anya can explain which profile facts produced the match.
 *   - nextStepGuidance — to produce actionable "finish your profile" cards.
 *   - UI/API — to render a completeness meter without bespoke logic per page.
 */

const FIELD_DEFS = Object.freeze([
  // Location & identity
  { key: 'country', weight: 2, section: 'basic_information', label: 'Country' },
  { key: 'state', weight: 3, section: 'location_focus', label: 'State/Region' },
  { key: 'city', weight: 2, section: 'location_focus', label: 'City' },
  { key: 'zip', weight: 2, section: 'location_focus', label: 'Postal/ZIP code' },

  // Organization shape
  { key: 'entityType', weight: 3, section: 'basic_information', label: 'Applicant type' },
  { key: 'organizationType', weight: 2, section: 'organization_details', label: 'Organization type' },
  { key: 'populationServed', weight: 2, section: 'organization_details', label: 'Population served' },
  { key: 'missionFocus', weight: 2, section: 'organization_details', label: 'Mission focus' },

  // Business / capacity
  { key: 'employeeCount', weight: 1, section: 'organization_details', label: 'Employee count' },
  { key: 'annualRevenue', weight: 1, section: 'financial_information', label: 'Annual revenue' },
  { key: 'yearsInOperation', weight: 1, section: 'organization_details', label: 'Years in operation' },
  { key: 'industry', weight: 1, section: 'organization_details', label: 'Industry' },

  // Ownership / targeted eligibility (each treated as binary presence)
  { key: 'isVeteranOwned', weight: 1, section: 'organization_details', label: 'Veteran-owned status' },
  { key: 'isWomanOwned', weight: 1, section: 'organization_details', label: 'Woman-owned status' },
  { key: 'isMinorityOwned', weight: 1, section: 'organization_details', label: 'Minority-owned status' },
  { key: 'isFaithBased', weight: 1, section: 'organization_details', label: 'Faith-based status' },
  { key: 'isTribal', weight: 1, section: 'organization_details', label: 'Tribal affiliation' },

  // Need signals
  { key: 'needCategories', weight: 4, section: 'funding_needs', label: 'Funding need categories', isArray: true },
  { key: 'fundingAmountNeeded', weight: 2, section: 'financial_information', label: 'Funding amount needed' },

  // Programs / services
  { key: 'programDescriptions', weight: 1, section: 'programs_services', label: 'Programs & services description', isArray: true },
])

const SECTION_LABELS = Object.freeze({
  basic_information: 'Basic Information',
  organization_details: 'Organization Details',
  location_focus: 'Location & Focus Area',
  programs_services: 'Programs & Services',
  funding_needs: 'Funding Needs',
  financial_information: 'Financial Information',
  comprehensive_application: 'Comprehensive Application',
})

const US_STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
])

const US_STATE_NAMES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming','district of columbia',
])

function isPresentScalar(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true // explicit false is still "covered"
  return true
}

function isPresentArray(value) {
  return Array.isArray(value) && value.length > 0
}

function firstSpecificLocationValue(normalized, keys) {
  for (const key of keys) {
    const value = normalized?.[key]
      ?? normalized?.location?.[key]
      ?? normalized?.address?.[key]
      ?? normalized?.basic_information?.[key]
      ?? normalized?.basic_information?.address?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function inferCountry(normalized) {
  const explicit = normalized?.country
    ?? normalized?.location?.country
    ?? normalized?.address?.country
    ?? normalized?.basic_information?.country
    ?? normalized?.basic_information?.address?.country
  if (isPresentScalar(explicit)) return explicit

  const state = firstSpecificLocationValue(normalized, ['state', 'region'])
  if (state) {
    const upper = state.toUpperCase()
    if (US_STATE_CODES.has(upper) || US_STATE_NAMES.has(state.toLowerCase())) return 'US'
  }

  const zip = firstSpecificLocationValue(normalized, ['zip', 'zip_code', 'postal', 'postal_code'])
  if (zip && /^\d{5}(?:-\d{4})?$/.test(zip)) return 'US'

  return null
}

function readField(normalized, key) {
  if (!normalized || typeof normalized !== 'object') return undefined
  if (normalized[key] !== undefined) return normalized[key]
  // Fall back to nested paths that profileNormalizer also exposes. Leave
  // booleans as `undefined` when neither the top-level nor the nested view
  // explicitly supplied a value — `false` is a real signal (user said no)
  // and should not be auto-fabricated by the coverage util.
  const nested = {
    country: inferCountry(normalized),
    state: normalized.state ?? normalized.location?.state ?? normalized.address?.state ?? null,
    city: normalized.city ?? normalized.location?.city ?? normalized.address?.city ?? null,
    zip: normalized.zip ?? normalized.location?.zip ?? normalized.location?.zip_code ?? normalized.address?.zip ?? normalized.address?.zip_code ?? null,
    employeeCount: normalized.employeeCount ?? normalized.business?.employeeCount ?? null,
    annualRevenue: normalized.annualRevenue ?? normalized.business?.annualRevenue ?? null,
    yearsInOperation: normalized.yearsInOperation ?? normalized.business?.yearsInOperation ?? null,
    industry: normalized.industry ?? normalized.business?.industry ?? null,
    populationServed: normalized.populationServed ?? normalized.organization?.populationServed ?? null,
    missionFocus: normalized.missionFocus ?? normalized.organization?.missionFocus ?? null,
    organizationType: normalized.organizationType ?? normalized.organization?.organizationType ?? null,
    isVeteranOwned: normalized.isVeteranOwned ?? normalized.ownership?.isVeteranOwned,
    isWomanOwned: normalized.isWomanOwned ?? normalized.ownership?.isWomanOwned,
    isMinorityOwned: normalized.isMinorityOwned ?? normalized.ownership?.isMinorityOwned,
    isFaithBased: normalized.isFaithBased ?? normalized.ownership?.isFaithBased,
    isTribal: normalized.isTribal ?? normalized.ownership?.isTribalGovernment,
    needCategories: normalized.needCategories ?? [],
    fundingAmountNeeded: normalized.fundingAmountNeeded ?? normalized.funding_amount_needed ?? null,
    programDescriptions: normalized.programDescriptions ?? [],
  }
  return nested[key]
}

function summarizeSections(sections) {
  if (!sections || typeof sections !== 'object') return { present: new Set(), keys: [] }
  const present = new Set()
  const keys = []
  for (const k of Object.keys(sections)) {
    keys.push(k)
    const raw = sections[k]
    const data = raw?.data ?? raw
    if (data && typeof data === 'object' && Object.keys(data).length > 0) present.add(k)
    else if (typeof data === 'string' && data.trim().length > 0) present.add(k)
  }
  return { present, keys }
}

/**
 * Compute coverage for a normalized profile.
 *
 * @param {object} normalized  - output of normalizeProfile
 * @param {object} [rawSections] - raw profile sections keyed by section_key
 * @returns {{
 *   coverage: number, completeness: string,
 *   fieldSignals: Array<{ key: string, label: string, section: string, present: boolean, weight: number }>,
 *   sectionSignals: Array<{ key: string, label: string, present: boolean }>,
 *   covered: string[], missingFields: string[], missingSections: string[],
 *   suggestions: Array<{ key: string, label: string, action: string }>,
 *   summary: string,
 * }}
 */
export function computeProfileCoverage(normalized, rawSections = null) {
  const fieldSignals = []
  let weighted = 0
  let weightedPresent = 0
  const covered = []
  const missingFields = []

  for (const def of FIELD_DEFS) {
    const value = readField(normalized, def.key)
    const present = def.isArray ? isPresentArray(value) : isPresentScalar(value)
    fieldSignals.push({
      key: def.key,
      label: def.label,
      section: def.section,
      weight: def.weight,
      present,
    })
    weighted += def.weight
    if (present) {
      weightedPresent += def.weight
      covered.push(def.key)
    } else {
      missingFields.push(def.key)
    }
  }

  const { present: presentSections } = summarizeSections(rawSections)
  const sectionSignals = Object.keys(SECTION_LABELS).map((key) => ({
    key,
    label: SECTION_LABELS[key],
    present: presentSections.has(key),
  }))
  const missingSections = sectionSignals.filter((s) => !s.present).map((s) => s.key)

  const coverage = weighted > 0 ? weightedPresent / weighted : 0
  const completeness =
    coverage >= 0.85 ? 'complete'
      : coverage >= 0.6 ? 'strong'
      : coverage >= 0.3 ? 'partial'
      : 'minimal'

  const suggestions = missingFields
    .map((key) => {
      const def = FIELD_DEFS.find((d) => d.key === key)
      if (!def) return null
      return {
        key,
        label: def.label,
        section: def.section,
        action: `Add your ${def.label.toLowerCase()} in the ${SECTION_LABELS[def.section] || def.section} section to improve match quality`,
      }
    })
    .filter(Boolean)
    .slice(0, 6)

  const summary = `${Math.round(coverage * 100)}% of matching-relevant profile signals are filled (${completeness}).`

  return {
    coverage,
    completeness,
    fieldSignals,
    sectionSignals,
    covered,
    missingFields,
    missingSections,
    suggestions,
    summary,
  }
}

/**
 * Return a short array of profile-signal descriptors that the matcher used.
 * Pure helper so matchEngine can surface them in match_explain without
 * re-implementing the readField/FIELD_DEFS table.
 */
export function listPresentProfileSignals(normalized) {
  return FIELD_DEFS
    .map((def) => {
      const value = readField(normalized, def.key)
      const present = def.isArray ? isPresentArray(value) : isPresentScalar(value)
      return { key: def.key, label: def.label, present, value: present ? value : null }
    })
    .filter((s) => s.present)
}

export const PROFILE_COVERAGE_FIELDS = FIELD_DEFS
export const PROFILE_COVERAGE_SECTIONS = SECTION_LABELS
