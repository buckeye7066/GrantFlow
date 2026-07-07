/**
 * Profile Readiness Service
 *
 * Validates whether a profile has enough data to generate meaningful
 * funding opportunity matches.  A "ready" profile must have at minimum:
 *
 *   1. A primary applicant type (primary_type / profile_category)
 *   2. A geographic signal (state or ZIP code)
 *   3. At least one intent signal (focus area, goal, keyword, or interest)
 *
 * If any requirement is missing this service returns a human-readable
 * `guidance` string so the caller can surface it to the end-user before
 * running a (likely empty) search.
 */

import { safeParseArrayField, resolveApplicantType } from './profileHelpers.js'
import {
  inferUsStateZipFromText,
  getExplicitStateZip,
  collectAddressTextForInference,
} from '../utils/inferLocationFromAddress.js'
import { isOrganizationProfileType } from '../../shared/profileSectionApplicability.js'
import { profileAlreadyAnswers } from './profileKnownFacts.js'

/**
 * @param {object} db
 * @param {string} profileId
 * @returns {Promise<{
 *   ready: boolean,
 *   score: number,          // 0–100 completeness score
 *   missing: string[],      // machine-readable missing signal codes
 *   guidance: string|null,  // human-readable guidance for the UI
 *   signals: object,        // summary of detected signals
 * }>}
 */
export async function checkProfileReadiness(db, profileId) {
  const missing = []
  const signals = {}

  if (!db || !profileId) {
    return {
      ready: false,
      score: 0,
      missing: ['profile_not_found'],
      guidance: 'Profile could not be loaded.',
      signals: {},
    }
  }

  // ── 1. Load profile row ────────────────────────────────────────────────────
  let profile
  try {
    const stmt = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1'); profile = await stmt.get(String(profileId))
  } catch (error) {
    return {
      ready: false,
      score: 0,
      missing: ['db_error'],
      guidance: 'Failed to load profile data.',
      signals: {},
    }
  }

  if (!profile) {
    return {
      ready: false,
      score: 0,
      missing: ['profile_not_found'],
      guidance: 'Profile not found.',
      signals: {},
    }
  }

  // ── 2. Load profile sections ───────────────────────────────────────────────
  let sectionRows = []
  try {
    sectionRows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
  } catch (error) {
    console.warn('Profile sections query failed:', error.message);
    // sections table may not exist on first boot; treat as empty
  }

  const sections = sectionRows.reduce((acc, row) => {
    try {
      acc[row.section_key] = row.data ? JSON.parse(row.data) : {}
    } catch (error) {
      console.warn(`Failed to parse JSON for section ${row.section_key}:`, error.message);
      acc[row.section_key] = {}
    }
    return acc
  }, {})

  const basic = sections?.basic_information ?? {}
  const narrative = sections?.narrative ?? {}
  const programsServices = sections?.programs_services ?? {}
  const locationFocus = sections?.location_focus ?? {}

  // ── 3. Check applicant type ────────────────────────────────────────────────
  const primaryType =
    resolveApplicantType(profile) ||
    basic.profile_category ||
    null

  if (primaryType) {
    signals.applicant_type = primaryType
  } else {
    missing.push('applicant_type')
  }

  // ── 4. Check geographic signal ────────────────────────────────────────────
  const addressBlob = collectAddressTextForInference(
    basic,
    locationFocus,
    null,
    sections?.comprehensive_application ?? {},
  )
  const inferred = inferUsStateZipFromText(addressBlob)
  const explicit = getExplicitStateZip(basic, locationFocus, null)
  const stateSignal =
    explicit.state ||
    profile.state ||
    inferred.state ||
    null
  const zipSignal =
    explicit.zip ||
    profile.postal_code ||
    profile.zip ||
    inferred.zip ||
    null

  if (stateSignal || zipSignal) {
    signals.location = { state: stateSignal, zip: zipSignal }
  } else {
    missing.push('location')
  }

  // ── 5. Check intent signals ────────────────────────────────────────────────
  // At least one meaningful intent signal must be present from:
  //   programs_services (focus_areas, keywords, interests) OR narrative (primary_goal, mission, target_population)
  const psFocusAreas = safeParseArrayField(programsServices.focus_areas, [])
  const psKeywords = safeParseArrayField(programsServices.keywords, [])
  const psInterests = safeParseArrayField(programsServices.interests, [])
  const hasPS = psFocusAreas.length > 0 || psKeywords.length > 0 || psInterests.length > 0

  const hasNarrative = Boolean(
    narrative.primary_goal ||
    narrative.mission ||
    narrative.target_population,
  )

  // Profile-level keywords / interests / tags as fallback
  const profileKeywords = safeParseArrayField(profile.keywords, [])
  const profileInterests = safeParseArrayField(profile.interests, [])
  const profileTags = safeParseArrayField(profile.tags, [])
  const hasProfileSignals = profileKeywords.length > 0 || profileInterests.length > 0 || profileTags.length > 0

  if (hasPS || hasNarrative || hasProfileSignals) {
    signals.intent = {
      programs_services: hasPS,
      narrative: hasNarrative,
      profile_level: hasProfileSignals,
    }
  } else {
    missing.push('intent_signals')
  }

  // ── 6. Compute score ──────────────────────────────────────────────────────
  // Equal weight across the three dimensions; each is worth 33 pts (rounding gives 99/100 max).
  const total = 3
  const present = total - missing.filter((m) => ['applicant_type', 'location', 'intent_signals'].includes(m)).length
  const score = Math.round((present / total) * 100)

  // ── 7. Build guidance message ─────────────────────────────────────────────
  let guidance = null
  if (missing.length > 0) {
    const tips = []
    if (missing.includes('applicant_type')) {
      tips.push('set an applicant type (e.g., individual, nonprofit, small business)')
    }
    if (missing.includes('location')) {
      tips.push('add a state or ZIP code in Basic Information')
    }
    if (missing.includes('intent_signals')) {
      tips.push(
        'add focus areas or keywords in Programs & Services, or fill in your Story & Goals',
      )
    }
    guidance =
      'To get relevant funding matches, please ' +
      tips.join(', and ') +
      '.'
  }

  // All 3 key signals required for a useful search (type, location, and at least one intent).
  // Without intent signals the crawler has nothing to filter against and returns empty results.
  const keyMissing = missing.filter((m) => ['applicant_type', 'location', 'intent_signals'].includes(m))
  const ready = keyMissing.length === 0

  return {
    ready,
    score,
    missing,
    guidance,
    signals,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Detailed 10-category readiness — used by the ProfileReadinessScore UI and
// by Robert when deciding whether a profile has enough information for
// high-quality matching.
//
// The original `checkProfileReadiness()` above stays unchanged — it is
// referenced by matching/discovery as a strict gate. The detailed function
// produces a richer, weighted breakdown plus per-category guidance for the
// UI checklist. They share the same source data.
// ─────────────────────────────────────────────────────────────────────────────

const READINESS_CATEGORIES = Object.freeze([
  { key: 'identity',       label: 'Identity / applicant type',           weight: 12 },
  { key: 'location',       label: 'Location',                            weight: 12 },
  { key: 'funding_needs',  label: 'Funding needs',                       weight: 12 },
  { key: 'amount',         label: 'Amount requested',                    weight: 8 },
  { key: 'eligibility',    label: 'Eligibility clues',                   weight: 10 },
  { key: 'org_status',     label: 'Organization / tax status',           weight: 10 },
  { key: 'documents',      label: 'Documents',                           weight: 8 },
  { key: 'timeline',       label: 'Timeline / deadlines',                weight: 8 },
  { key: 'narrative',      label: 'Narrative / project description',     weight: 12 },
  { key: 'contact',        label: 'Contact / application readiness',     weight: 8 },
])

function statusForScore(score) {
  if (score >= 85) return 'excellent'
  if (score >= 65) return 'good'
  if (score >= 35) return 'needs_work'
  return 'poor'
}

function pickFirstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function isPresentArray(v) {
  const arr = safeParseArrayField(v, [])
  return Array.isArray(arr) && arr.length > 0
}

/**
 * Compute the 10-category readiness breakdown.
 *
 * Returns:
 *   {
 *     profile_id,
 *     readiness_score: 0..100,
 *     status: 'excellent' | 'good' | 'needs_work' | 'poor',
 *     categories: [{ key, label, weight, earned, present, missing_items, recommended_questions }],
 *     missing_items: string[],
 *     recommended_questions: string[],
 *     impact_on_matching: string,
 *     updated_at: ISO,
 *   }
 *
 * Designed so missing fields *reduce* the score but never disqualify the
 * profile from a search — consistent with the mission rule "profile fields
 * increase score, not eliminate results."
 */
export async function computeDetailedReadiness(db, profileId) {
  const updated_at = new Date().toISOString()
  if (!db || !profileId) {
    return {
      profile_id: profileId || null,
      readiness_score: 0,
      status: 'poor',
      categories: [],
      missing_items: ['profile_not_found'],
      recommended_questions: [],
      impact_on_matching: 'Profile could not be loaded.',
      updated_at,
    }
  }

  let profile
  try {
    profile = await db
      .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
      .get(String(profileId))
  } catch {
    profile = null
  }
  if (!profile) {
    return {
      profile_id: profileId,
      readiness_score: 0,
      status: 'poor',
      categories: [],
      missing_items: ['profile_not_found'],
      recommended_questions: [],
      impact_on_matching: 'Profile not found.',
      updated_at,
    }
  }

  let sectionRows = []
  try {
    sectionRows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
  } catch {
    sectionRows = []
  }
  const sections = sectionRows.reduce((acc, row) => {
    try {
      acc[row.section_key] = row.data ? JSON.parse(row.data) : {}
    } catch {
      acc[row.section_key] = {}
    }
    return acc
  }, {})

  const basic = sections.basic_information || {}
  const narrative = sections.narrative || {}
  const programsServices = sections.programs_services || {}
  const locationFocus = sections.location_focus || {}
  const orgDetails = sections.organization_details || {}
  const nonprofitCompliance = sections.nonprofit_compliance || {}
  const small = sections.small_business_details || {}
  const employment = sections.employment || {}
  const housing = sections.housing || {}
  const family = sections.family || {}
  const education = sections.education || {}
  const health = sections.health_medical || {}

  // Document presence (best-effort — table may not exist on every deployment).
  let documentsCount = 0
  try {
    const r = await db
      .prepare('SELECT COUNT(*) AS n FROM documents WHERE profile_id = ?')
      .get(String(profileId))
    documentsCount = Number(r?.n || 0)
  } catch {
    documentsCount = 0
  }

  const categories = []

  // Known-facts choke point (profileKnownFacts.js): a category's PRESENCE
  // check must see the fact wherever it actually lives (canonical home OR any
  // alias section — e.g. veteran in demographics.veteran_status, income in
  // financial_information.household_income, amount in
  // financial_information.funding_amount_needed). The narrow per-category
  // clue lists below stay as the first-line check; `known()` is the net so a
  // present fact is never counted as missing (which both re-asked the user
  // AND under-scored readiness — the owner's duplicate-qualifier-question
  // class).
  const factCtx = { profile, sections }
  const known = (factId) => profileAlreadyAnswers(factId, factCtx)

  // 1. Identity / applicant type ─────────────────────────────────────────────
  {
    const primaryType = resolveApplicantType(profile) || basic.profile_category || null
    const present = Boolean(primaryType) || known('applicant_type')
    categories.push({
      key: 'identity',
      label: 'Identity / applicant type',
      weight: 12,
      earned: present ? 12 : 0,
      present,
      missing_items: present ? [] : ['Set a primary applicant type (individual, family, school, nonprofit, etc.)'],
      recommended_questions: present
        ? []
        : ['What kind of applicant are you — an individual, family, school, ministry, business, fire department, nonprofit, or something else?'],
    })
  }

  // 2. Location ──────────────────────────────────────────────────────────────
  {
    const addressBlob = collectAddressTextForInference(
      basic,
      locationFocus,
      null,
      sections.comprehensive_application || {},
    )
    const inferred = inferUsStateZipFromText(addressBlob)
    const explicit = getExplicitStateZip(basic, locationFocus, null)
    const state = explicit.state || profile.state || inferred.state || null
    const zip = explicit.zip || profile.postal_code || profile.zip || inferred.zip || null
    const city = pickFirstString(basic.city, locationFocus.city, profile.city)
    const present = Boolean(state || zip) || known('state_zip')
    const hasCity = Boolean(city) || known('city')
    const earned = present ? (hasCity ? 12 : 9) : 0
    const missing = []
    if (!present) missing.push('Add a state or ZIP code in Basic Information.')
    else if (!hasCity) missing.push('Add a city for sharper geographic matching.')
    categories.push({
      key: 'location',
      label: 'Location',
      weight: 12,
      earned,
      present,
      missing_items: missing,
      recommended_questions: present ? [] : ['Where are you located — what city, state, or ZIP code?'],
    })
  }

  // 3. Funding needs ─────────────────────────────────────────────────────────
  {
    const focus = isPresentArray(programsServices.focus_areas)
    const keywords = isPresentArray(programsServices.keywords) || isPresentArray(profile.keywords)
    const interests = isPresentArray(programsServices.interests) || isPresentArray(profile.interests)
    const goal = pickFirstString(narrative.primary_goal, narrative.target_population)
    const present = focus || keywords || interests || Boolean(goal) || known('primary_need')
    const earned = present ? 12 : 0
    categories.push({
      key: 'funding_needs',
      label: 'Funding needs',
      weight: 12,
      earned,
      present,
      missing_items: present
        ? []
        : ['Add focus areas, keywords, or a primary funding goal so we know what to search for.'],
      recommended_questions: present
        ? []
        : ['What kind of funding or help are you looking for?'],
    })
  }

  // 4. Amount requested ──────────────────────────────────────────────────────
  {
    const amt = pickFirstString(
      narrative.amount_requested,
      narrative.budget_total,
      programsServices.amount_requested,
      small.requested_amount,
    )
    // known('funding_amount') closes the alias gap: the gap interview and the
    // profile editor store the amount under narrative/financial_information
    // `funding_amount_needed`, which the original clue list never read — the
    // user was re-asked for an amount they had already given AND the category
    // scored 0 (present-fact-counted-as-missing bug).
    const present = Boolean(amt) || (Number(profile.amount_requested) > 0) || known('funding_amount')
    categories.push({
      key: 'amount',
      label: 'Amount requested',
      weight: 8,
      earned: present ? 8 : 0,
      present,
      missing_items: present ? [] : ['Add an approximate funding amount you need.'],
      recommended_questions: present ? [] : ['Roughly how much funding are you looking for?'],
    })
  }

  // 5. Eligibility clues ─────────────────────────────────────────────────────
  {
    const clues = [
      programsServices.eligibility_notes,
      narrative.eligibility_notes,
      orgDetails.constraints,
      family.veteran_status,
      family.disability_status,
      employment.income_range,
      housing.housing_status,
      education.school_type,
      health.health_status,
    ]
    // known('eligibility_traits') closes the alias gap: veteran status lives in
    // demographics.veteran_status / military_service.veteran, disability in
    // demographics/health_medical, income in financial_information — none of
    // which the original clue list read, so a profile with those facts filled
    // was still asked the eligibility question AND lost the 10 points
    // (present-fact-counted-as-missing bug).
    const has = clues.some((v) => typeof v === 'string' && v.trim()) || known('eligibility_traits')
    categories.push({
      key: 'eligibility',
      label: 'Eligibility clues',
      weight: 10,
      earned: has ? 10 : 0,
      present: has,
      missing_items: has
        ? []
        : ['Share any eligibility-relevant facts (income range, veteran status, disability, housing, school type, etc.).'],
      recommended_questions: has
        ? []
        : ['Are there any facts about you or your organization that affect what funders you qualify for? (income, status, type, etc.)'],
    })
  }

  // 6. Organization / tax status ─────────────────────────────────────────────
  {
    const orgType = pickFirstString(
      orgDetails.organization_type,
      orgDetails.legal_form,
      small.legal_form,
      basic.organization_type,
    )
    // Tax status may be free text OR the boolean 501(c)(3) toggles the profile
    // editor writes — check all of them so a filled nonprofit is not told to
    // "add tax status" it already provided (present-fact-counted-as-missing).
    const taxStatus = pickFirstString(
      nonprofitCompliance.tax_exempt_status,
      orgDetails.tax_status,
      small.tax_classification,
    ) ||
      nonprofitCompliance.is_501c3 === true ||
      nonprofitCompliance.is_501c3_public_charity === true ||
      nonprofitCompliance.is_501c3_private_foundation === true ||
      orgDetails.is_501c3_public_charity === true ||
      orgDetails.is_501c3_private_foundation === true
    // Canonical org classifier (shared/profileSectionApplicability) instead of
    // a stale hardcoded 6-type list — county_government, library, food_pantry
    // etc. are org profiles too and should be asked for org/tax status.
    const isOrgProfile = isOrganizationProfileType(
      resolveApplicantType(profile) || basic.profile_category,
    )
    const present = Boolean(orgType || taxStatus)
    let earned
    if (!isOrgProfile) {
      // Individual / family profiles don't need tax status — give partial credit by default.
      earned = 7
    } else {
      earned = present ? 10 : 0
    }
    categories.push({
      key: 'org_status',
      label: 'Organization / tax status',
      weight: 10,
      earned,
      present: present || !isOrgProfile,
      missing_items:
        isOrgProfile && !present
          ? ['Add organization type and tax status (e.g., 501(c)(3), LLC, public school).']
          : [],
      recommended_questions:
        isOrgProfile && !present
          ? ['What kind of organization is this? Do you have a tax-exempt status (e.g., 501(c)(3))?']
          : [],
    })
  }

  // 7. Documents ─────────────────────────────────────────────────────────────
  {
    const present = documentsCount > 0
    categories.push({
      key: 'documents',
      label: 'Documents',
      weight: 8,
      earned: present ? 8 : 0,
      present,
      missing_items: present
        ? []
        : ['Upload supporting documents (501(c)(3) letter, tax return, mission statement, etc.).'],
      recommended_questions: present
        ? []
        : ['Do you have any supporting documents we should keep on file (organizational, financial, narrative)?'],
    })
  }

  // 8. Timeline / deadlines ──────────────────────────────────────────────────
  {
    const timeline = pickFirstString(
      narrative.timeline,
      programsServices.timeline,
      narrative.urgency,
      programsServices.urgency,
    )
    const present = Boolean(timeline)
    categories.push({
      key: 'timeline',
      label: 'Timeline / deadlines',
      weight: 8,
      earned: present ? 8 : 0,
      present,
      missing_items: present ? [] : ['Add a timeline or urgency window for your funding need.'],
      recommended_questions: present
        ? []
        : ['When do you need this funding? Is there a specific deadline you are working toward?'],
    })
  }

  // 9. Narrative / project description ───────────────────────────────────────
  {
    const text = pickFirstString(
      narrative.mission,
      narrative.project_description,
      narrative.story,
      programsServices.description,
    )
    const long = text && text.length >= 80
    categories.push({
      key: 'narrative',
      label: 'Narrative / project description',
      weight: 12,
      earned: long ? 12 : text ? 6 : 0,
      present: Boolean(text),
      missing_items: long
        ? []
        : text
        ? ['Expand the narrative — funders prefer 80+ characters of context.']
        : ['Write a short paragraph about your mission, project, or goal.'],
      recommended_questions: text
        ? []
        : ['In a few sentences, what are you trying to do and why is it meaningful?'],
    })
  }

  // 10. Contact / application readiness ──────────────────────────────────────
  {
    const email = pickFirstString(basic.email, profile.contact_email, profile.email)
    const phone = pickFirstString(basic.phone, profile.contact_phone, profile.phone)
    const website = pickFirstString(basic.website, orgDetails.website, profile.website)
    const present = Boolean(email)
    const earned = present + (phone ? 1 : 0) + (website ? 1 : 0)
    categories.push({
      key: 'contact',
      label: 'Contact / application readiness',
      weight: 8,
      earned: Math.min(8, earned * 4),
      present,
      missing_items: present ? [] : ['Add an email address so applications can be tied to a contact point.'],
      recommended_questions: present
        ? []
        : ['What email address should funders use to reach you about this profile?'],
    })
  }

  const earnedTotal = categories.reduce((s, c) => s + c.earned, 0)
  const weightTotal = categories.reduce((s, c) => s + c.weight, 0) || 100
  const readiness_score = Math.max(0, Math.min(100, Math.round((earnedTotal / weightTotal) * 100)))

  const missing_items = categories.flatMap((c) => c.missing_items)
  const recommended_questions = categories.flatMap((c) => c.recommended_questions)
  const status = statusForScore(readiness_score)

  let impact_on_matching
  if (readiness_score >= 85) {
    impact_on_matching = 'Profile is detailed enough for high-quality, targeted matches.'
  } else if (readiness_score >= 65) {
    impact_on_matching = 'Matches will be reasonable. A few more details will sharpen geography and eligibility.'
  } else if (readiness_score >= 35) {
    impact_on_matching = 'Matches will be broad. Add the missing items below for sharper targeting.'
  } else {
    impact_on_matching = 'Matches will be very broad. Add basic details so we can find real funding sources for you.'
  }

  return {
    profile_id: profileId,
    readiness_score,
    status,
    categories,
    missing_items,
    recommended_questions,
    impact_on_matching,
    updated_at,
  }
}

export const READINESS_CATEGORY_DEFINITIONS = READINESS_CATEGORIES

export const __testables = { statusForScore }
