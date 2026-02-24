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

import { safeParseArrayField } from './profileHelpers.js'

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
    profile = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
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
  } catch {
    // sections table may not exist on first boot; treat as empty
  }

  const sections = sectionRows.reduce((acc, row) => {
    try {
      acc[row.section_key] = row.data ? JSON.parse(row.data) : {}
    } catch {
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
    profile.primary_type ||
    basic.profile_category ||
    null

  if (primaryType) {
    signals.applicant_type = primaryType
  } else {
    missing.push('applicant_type')
  }

  // ── 4. Check geographic signal ────────────────────────────────────────────
  const stateSignal =
    basic.state ||
    profile.state ||
    locationFocus.primary_state ||
    null
  const zipSignal =
    basic.zip ||
    profile.postal_code ||
    profile.zip ||
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

  const ready = missing.length === 0

  return {
    ready,
    score,
    missing,
    guidance,
    signals,
  }
}
