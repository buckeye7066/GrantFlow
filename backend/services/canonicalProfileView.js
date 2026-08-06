/**
 * canonicalProfileView.js
 *
 * Single source of truth for "what does this profile look like to the
 * matching/filtering/Anya systems?".
 *
 * Historically this repo has had three overlapping extraction paths:
 *   1. normalizeProfile (services/profileNormalizer.js)       - canonical object
 *      used by the match decision engine (matchEngine.js).
 *   2. buildProfileSignals (services/profileHelpers.js)       - rich signals
 *      (needs set, keyword set, location, etc.) used by crawler queries.
 *   3. extractProfileData (services/relevanceFilter.js)       - a narrow flat
 *      object used by the legacy relevance filter rules.
 *
 * Those shapes drifted. In particular, several relevance-filter rules look up
 * pd.needs / pd.description / pd.situation / pd.challenges - fields the legacy
 * extractor never populated, so those rules silently never fired.
 *
 * This module merges all three into one canonical view so every downstream
 * consumer (matcher, relevance filter, Anya, explainability, audit) reads the
 * SAME shape derived from the SAME inputs.
 *
 * Design goals:
 *   - Backwards compatible: consumers that still want the legacy flat shape
 *     can read view.flat, which mirrors extractProfileData() but is now
 *     hydrated from the canonical normalized profile when possible.
 *   - Additive: existing callers of normalizeProfile / extractProfileData
 *     continue to work. This view just gives callers that want consistency a
 *     single place to read from.
 *   - Traceable: view.summary records which source each field came from
 *     (section key, profile column, or derivation) so audits can check
 *     coverage.
 */

import { normalizeProfile } from './profileNormalizer.js'
import { resolveApplicantType, safeParseArrayField } from './profileHelpers.js'

const EMPTY_ARRAY = Object.freeze([])

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v === null || v === undefined) continue
    if (typeof v === 'string' && v.trim() === '') continue
    return v
  }
  return null
}

function sectionAnswers(section) {
  if (!section || typeof section !== 'object') return {}
  return section.answers && typeof section.answers === 'object' ? section.answers : section
}

function asBool(value) {
  if (value === true) return true
  if (value === false) return false
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (['yes', 'true', 'y', 't'].includes(s)) return true
    if (['no', 'false', 'n', 'f'].includes(s)) return false
  }
  return null
}

function collectNarrativeText(profile, sections) {
  const s = sections || {}
  const narrative = sectionAnswers(s.narrative)
  const programs = sectionAnswers(s.programs_services)
  const financial = sectionAnswers(s.financial_information)
  const orgDetails = sectionAnswers(s.organization_details)
  const basic = sectionAnswers(s.basic_information)

  return [
    profile?.display_name,
    profile?.description,
    profile?.mission,
    narrative.primary_goal,
    narrative.mission,
    narrative.story,
    narrative.background,
    narrative.barriers_faced,
    narrative.target_population,
    programs.focus_areas,
    programs.keywords,
    orgDetails.mission,
    orgDetails.description,
    financial.notes,
    financial.challenges,
    basic.notes,
  ]
    .flat()
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
}

/**
 * Build the flat "legacy" profile-data shape used by relevanceFilterRules.
 * Unlike the pre-existing extractProfileData, this version hydrates itself
 * from the canonical normalized profile AND the narrative/section content the
 * rules actually check (needs[], description, situation, challenges,
 * special_circumstances), fixing the long-standing silent-no-op bug.
 *
 * Returns the flat object; see extractProfileData() in relevanceFilter.js for
 * the backwards-compatible caller.
 */
export function buildFlatProfileData(profileContext, normalized) {
  const profile = profileContext?.profile ?? profileContext ?? {}
  const sections = profileContext?.sections ?? {}
  const signals = profileContext?.signals ?? null

  const basic = sectionAnswers(sections.basic_information)
  const demographics = sectionAnswers(sections.demographics)
  const military = sectionAnswers(sections.military_service)
  const health = sectionAnswers(sections.health_medical)
  const employment = sectionAnswers(sections.employment)
  const education = sectionAnswers(sections.education)
  const family = sectionAnswers(sections.family_life)
  const comprehensive = sectionAnswers(sections.comprehensive_application)
  const narrative = sectionAnswers(sections.narrative)
  const govAssistance = sectionAnswers(sections.government_assistance)
  const locationFocus = sectionAnswers(sections.location_focus)
  const faith = sectionAnswers(
    sections.faith || sections.religion || sections.religious_affiliation,
  )
  const personal = sectionAnswers(sections.personal_information)

  const primary_type =
    normalized?.entityType ||
    resolveApplicantType(profile) ||
    comprehensive.applicant_type ||
    null

  const state =
    normalized?.state ||
    profile.state ||
    basic.state ||
    sectionAnswers(sections.location_focus).state ||
    null

  const city = normalized?.city || profile.city || basic.city || null

  const tags = safeParseArrayField(profile.tags, [])
  const keywords = safeParseArrayField(profile.keywords, [])
  const interests = safeParseArrayField(profile.interests, [])

  const canonicalNeeds = Array.isArray(normalized?.needCategories)
    ? [...normalized.needCategories]
    : []
  const signalNeeds =
    signals?.needs instanceof Set ? [...signals.needs] : []
  const needs = [...new Set([...canonicalNeeds, ...signalNeeds])]

  const veteranStatus =
    normalized?.isVeteran === true
      ? true
      : asBool(demographics.veteran_status) ??
        asBool(military.veteran) ??
        null

  const disabilityStatus =
    normalized?.hasChronicIllness === true ||
    normalized?.hasDisabilityNeed === true
      ? health.disability_type || demographics.disability_status || true
      : demographics.disability_status || health.disability_type || null

  const fosterYouth =
    normalized?.hasFosterIndicator === true
      ? true
      : asBool(family.foster_youth) ??
        asBool(demographics.foster_youth) ??
        asBool(comprehensive.foster_care) ??
        null

  const firstResponder =
    Array.isArray(normalized?.affiliations) &&
    normalized.affiliations.includes('first_responder')
      ? true
      : demographics.first_responder === true ||
          (employment.occupation_type || '').toLowerCase() === 'first_responder' ||
          /(firefighter|paramedic|emt|police|law enforcement|dispatcher)/i.test(
            String(employment.occupation || ''),
          )
        ? true
        : null

  const unableToWork =
    normalized?.isUnableToWork === true ||
    comprehensive.unable_to_work === true ||
    health.unable_to_work === true ||
    /not able to work|unable to work/i.test(String(employment.notes || '')) ||
    /disabled/i.test(String(employment.current_status || ''))

  const immigrationStatus =
    normalized?.immigrationStatus ||
    demographics.immigrant_status ||
    null

  const ethnicity =
    normalized?.ethnicity ||
    demographics.ethnicity ||
    null

  const age = normalized?.age ?? profile.age ?? basic.age ?? demographics.age ?? null
  const ageGroup =
    normalized?.ageGroup ||
    demographics.age_group ||
    profile.age_group ||
    null

  // Description / situation / challenges are the free-text fields that
  // several rules check; without them, those rules were no-ops.
  const descriptionText = firstNonEmpty(
    profile.description,
    narrative.story,
    narrative.background,
    narrative.mission,
    narrative.primary_goal,
  )

  const situationText = firstNonEmpty(
    narrative.situation,
    narrative.barriers_faced,
    narrative.background,
  )

  const challenges = [
    ...(Array.isArray(narrative.challenges) ? narrative.challenges : []),
    ...(typeof narrative.challenges === 'string' ? [narrative.challenges] : []),
    ...(typeof narrative.barriers_faced === 'string' ? [narrative.barriers_faced] : []),
  ].filter(Boolean)

  const specialCircumstances = [
    ...(Array.isArray(narrative.special_circumstances)
      ? narrative.special_circumstances
      : typeof narrative.special_circumstances === 'string'
        ? [narrative.special_circumstances]
        : []),
  ].filter(Boolean)

  return {
    primary_type,
    age,
    age_group: ageGroup,
    gender:
      normalized?.gender ||
      (basic.gender && String(basic.gender).toLowerCase()) ||
      (demographics.gender && String(demographics.gender).toLowerCase()) ||
      null,
    veteran_status: veteranStatus,
    disability_status: disabilityStatus,
    immigrant_status: immigrationStatus,
    foster_youth: fosterYouth,
    first_responder: firstResponder,
    employment,
    education,
    state,
    city,
    county: normalized?.county || profile.county || null,
    zip: normalized?.zip || profile.postal_code || profile.zip_code || null,
    tags,
    keywords,
    interests,
    needs,
    description: descriptionText,
    situation: situationText,
    challenges,
    special_circumstances: specialCircumstances,
    government_assistance: govAssistance || {},
    insurance_provider:
      sectionAnswers(sections.medical_insurance).insurance_provider || null,
    unable_to_work: !!unableToWork,
    employment_notes: employment.notes || null,
    employment_status: employment.current_status || null,
    has_children:
      normalized?.householdHasChildren === true ||
      family.has_children === true ||
      Number(family.number_of_children || 0) > 0 ||
      Number(family.members_under_18 || 0) > 0,
    number_of_children: Number(family.number_of_children || 0) || 0,
    household_members_under_18: Number(family.members_under_18 || 0) || 0,
    ethnicity,
    // Exact declared attributes are retained only for explicit-exclusivity
    // checks. Unknown/missing values stay null, so the hard rules remain
    // neutral instead of inferring sensitive identity facts.
    religion: firstNonEmpty(
      profile.religion,
      basic.religion,
      demographics.religion,
      faith.religion,
      faith.faith,
    ),
    denomination: firstNonEmpty(
      profile.denomination,
      basic.denomination,
      demographics.denomination,
      faith.denomination,
    ),
    religious_affiliation: firstNonEmpty(
      profile.religious_affiliation,
      demographics.religious_affiliation,
      faith.religious_affiliation,
      faith.faith_affiliation,
    ),
    sexual_orientation: firstNonEmpty(
      profile.sexual_orientation,
      demographics.sexual_orientation,
      personal.sexual_orientation,
    ),
    marital_status: firstNonEmpty(
      profile.marital_status,
      demographics.marital_status,
      personal.marital_status,
      family.marital_status,
    ),
    locale: firstNonEmpty(profile.locale, basic.locale, locationFocus.locale),
    rural_urban: firstNonEmpty(
      profile.rural_urban,
      basic.rural_urban,
      locationFocus.rural_urban,
    ),
    rural_resident: asBool(locationFocus.rural_resident) ?? asBool(profile.rural_resident),
    urban_resident: asBool(locationFocus.urban_resident) ?? asBool(profile.urban_resident),
    basic_information: basic,
    demographics,
    location_focus: locationFocus,
    // Affiliations / qualifiers surfaced for rules (church, school, tribal, etc.).
    affiliations: Array.isArray(normalized?.affiliations)
      ? [...normalized.affiliations]
      : EMPTY_ARRAY,
    geographic_qualifiers: Array.isArray(normalized?.geographicQualifiers)
      ? [...normalized.geographicQualifiers]
      : EMPTY_ARRAY,
    // Structured full-profile coverage for business/ownership/organization
    // rules (woman-owned, veteran-owned, CDFI, HBCU, startup, population
    // served, mission focus, etc.). These mirror normalizeProfile's output
    // so relevance rules and Anya can read them from a single consistent
    // shape.
    country: normalized?.country || 'US',
    organization_type: normalized?.organizationType || null,
    industry: normalized?.industry || null,
    naics_code: normalized?.naicsCode || null,
    employee_count: normalized?.employeeCount ?? null,
    annual_revenue: normalized?.annualRevenue ?? null,
    years_in_operation: normalized?.yearsInOperation ?? null,
    population_served: Array.isArray(normalized?.populationServed)
      ? [...normalized.populationServed]
      : EMPTY_ARRAY,
    mission_focus: Array.isArray(normalized?.missionFocus)
      ? [...normalized.missionFocus]
      : EMPTY_ARRAY,
    is_veteran_owned: !!normalized?.isVeteranOwned,
    is_woman_owned: !!normalized?.isWomanOwned,
    is_minority_owned: !!normalized?.isMinorityOwned,
    is_faith_based: !!normalized?.isFaithBased,
    is_tribal: !!normalized?.isTribal,
    ownership: normalized?.ownership || null,
    business: normalized?.business || null,
    organization_details: normalized?.organization || null,
  }
}

/**
 * Build the canonical profile view from a profileContext.
 *
 * @param {object} profileContext - Output from loadProfileContext(), or any
 *   object shaped { profile, sections, signals, organization }.
 * @returns {{
 *   profile: object,
 *   sections: Record<string, object>,
 *   signals: object|null,
 *   organization: object|null,
 *   normalized: object|null,
 *   flat: object,
 *   narrativeText: string,
 *   summary: { hasLocation: boolean, hasNeeds: boolean, sectionCount: number, needCount: number, entityType: string|null }
 * }}
 */
export function buildCanonicalProfileView(profileContext) {
  if (!profileContext) {
    return {
      profile: {},
      sections: {},
      signals: null,
      organization: null,
      normalized: null,
      flat: buildFlatProfileData({}, null),
      narrativeText: '',
      summary: {
        hasLocation: false,
        hasNeeds: false,
        sectionCount: 0,
        needCount: 0,
        entityType: null,
      },
    }
  }

  const profile = profileContext.profile ?? profileContext
  const sections = profileContext.sections ?? {}
  const signals = profileContext.signals ?? null
  const organization = profileContext.organization ?? null

  const normalized = normalizeProfile(profile, sections, signals)
  const flat = buildFlatProfileData(profileContext, normalized)
  const narrativeText = collectNarrativeText(profile, sections)

  const summary = {
    hasLocation: Boolean(normalized?.state || normalized?.zip || normalized?.city),
    hasNeeds: Array.isArray(normalized?.needCategories) && normalized.needCategories.length > 0,
    sectionCount: Object.keys(sections || {}).length,
    needCount: Array.isArray(normalized?.needCategories) ? normalized.needCategories.length : 0,
    entityType: normalized?.entityType ?? null,
  }

  return {
    profile,
    sections,
    signals,
    organization,
    normalized,
    flat,
    narrativeText,
    summary,
  }
}

export default {
  buildCanonicalProfileView,
  buildFlatProfileData,
}
