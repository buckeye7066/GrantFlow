/**
 * studentBridgeFunding/expander.js
 *
 * Given a profile + sections, instantiate the bridge-funding template
 * catalog into concrete `opportunity_data` blobs ready for ingestion into
 * funding_opportunities + the profile's grants pipeline.
 *
 * Pure function — no DB, no HTTP. Output is deterministic for the same
 * (profile, sections, today) inputs so unit tests stay stable.
 */

import { deriveStudentCycle } from './calendar.js'
import { resolveTargetSchool } from './schoolResolver.js'
import { STUDENT_BRIDGE_FUNDING_TEMPLATES } from './templates.js'
import { extractStateFromContext, extractZipFromContext, extractCityFromContext } from '../profileHelpers.js'

function deriveHomeContext({ profile, sections }) {
  const state = (extractStateFromContext({ profile, sections }) || '').toUpperCase() || null
  const zip = extractZipFromContext({ profile, sections }) || null
  const city = extractCityFromContext({ profile, sections }) || null
  let county =
    sections?.basic_information?.county ||
    sections?.location?.county ||
    sections?.address?.county ||
    null
  if (county && !/county$/i.test(county)) {
    county = `${county.replace(/\s+county$/i, '').trim()} County`
  }
  return { state, zip, city, county }
}

/**
 * @param {object} args
 * @param {object} args.profile           - profile row
 * @param {object} args.sections          - keyed by section_key (output of buildProfileContext)
 * @param {Date}   [args.today]           - injectable for tests
 * @returns {{
 *   isStudent: boolean,
 *   calendar: object,
 *   school: object|null,
 *   collegeState: string|null,
 *   collegeCounty: string|null,
 *   collegeTown: string|null,
 *   homeState: string|null,
 *   homeCounty: string|null,
 *   homeCity: string|null,
 *   opportunities: Array<object>,
 *   skippedTemplates: Array<{id: string, reason: string}>,
 * }}
 */
export function expandStudentBridgeFunding({ profile, sections = {}, today: todayInput } = {}) {
  const today = todayInput || new Date()

  const calendar = deriveStudentCycle({ profile, sections, today })
  if (!calendar.isStudent || !calendar.enrollmentYear) {
    return {
      isStudent: false,
      calendar,
      school: null,
      collegeState: null,
      collegeCounty: null,
      collegeTown: null,
      homeState: null,
      homeCounty: null,
      homeCity: null,
      opportunities: [],
      skippedTemplates: [],
    }
  }

  const school = resolveTargetSchool({ profile, sections })
  const home = deriveHomeContext({ profile, sections })

  const collegeState = school?.state || home.state
  const collegeCounty = school?.county || home.county
  const collegeTown = school?.city || home.city

  const ctx = {
    profile,
    sections,
    calendar,
    school,
    state: collegeState,
    county: collegeCounty,
    collegeState,
    collegeCounty,
    collegeTown,
    homeState: home.state,
    homeCounty: home.county,
    homeCity: home.city,
    today,
  }

  const opportunities = []
  const skippedTemplates = []

  for (const tpl of STUDENT_BRIDGE_FUNDING_TEMPLATES) {
    let applies = true
    try {
      applies = typeof tpl.appliesIf === 'function' ? tpl.appliesIf(ctx) : true
    } catch (err) {
      applies = false
      skippedTemplates.push({ id: tpl.id, reason: `appliesIf threw: ${err?.message || err}` })
      continue
    }
    if (!applies) {
      skippedTemplates.push({ id: tpl.id, reason: 'appliesIf returned false' })
      continue
    }

    let built
    try {
      built = tpl.build(ctx)
    } catch (err) {
      skippedTemplates.push({ id: tpl.id, reason: `build threw: ${err?.message || err}` })
      continue
    }
    if (!built) {
      skippedTemplates.push({ id: tpl.id, reason: 'build returned null (insufficient context)' })
      continue
    }
    if (!built.title || !built.application_url) {
      skippedTemplates.push({ id: tpl.id, reason: 'missing title or application_url' })
      continue
    }

    opportunities.push({
      template_id: tpl.id,
      category: tpl.category,
      source: tpl.source,
      match_score: tpl.matchScore,
      is_loan: Boolean(tpl.isLoan),
      opportunity_data: {
        ...built,
        source: tpl.source,
        applicationNote:
          built.applicationNote ||
          `Bridge-funding template ${tpl.id} for ${calendar.academicCycle} cycle.`,
      },
    })
  }

  return {
    isStudent: true,
    calendar,
    school,
    collegeState,
    collegeCounty,
    collegeTown,
    homeState: home.state,
    homeCounty: home.county,
    homeCity: home.city,
    opportunities,
    skippedTemplates,
  }
}
