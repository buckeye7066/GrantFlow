/**
 * acceptedFundingSources.js — what GrantFlow should PUSH to a portal.
 *
 * OWNER RULE (2026-08-01): "the two-way sync should be global for all portals…
 * add to the portal what funding sources have been accepted in GrantFlow, and
 * add to GrantFlow what the portal shows."
 *
 * This is the WRITE side's source of truth. It matters beyond convenience:
 * schools and many funders REQUIRE a student to report outside scholarships
 * they have received, and an unreported award can mean a revised aid package or
 * a repayment demand later.
 *
 * WHY IT READS THE PIPELINE, NOT A SECTION: the previous writer
 * (`profileToFundingSources`) read only `university_applications` — the
 * school-import section. Awards the household actually won through GrantFlow
 * live in the `grants` pipeline, so the writer pushed a partial, school-shaped
 * list and silently omitted everything else. "Accepted" is a pipeline fact.
 *
 * ACCEPTED means the household actually HAS the money:
 *   - status 'awarded' (the canonical terminal win in shared/pipelineStages.js), OR
 *   - a positive `amount_awarded` — money recorded as received regardless of
 *     what the status column says (statuses drift; a recorded award does not).
 * A merely-submitted or in-progress application is NOT reported: telling a
 * school you received aid you have only applied for would be a false statement
 * on a financial-aid record.
 *
 * The profile's aid-type preference still applies — a household that declined
 * loans never has one pushed anywhere on its behalf.
 */

import { evaluateAwardAgainstPreferences } from '../../../config/aidTypePreferences.js'
import { createLogger } from '../../../utils/logger.js'

const log = createLogger('service:acceptedFundingSources')

// Bounded: a portal form is filled one row at a time and a runaway list would
// hammer a real institution's site. Reported when it truncates (no silent caps).
const MAX_SOURCES = 25

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Collect the funding sources this profile has ACCEPTED, ready to report to a
 * portal. Returns { sources, declinedByPreference, truncated }.
 *
 * @returns {Promise<{sources: Array<{name,amount,sponsor,source,aidType}>,
 *   declinedByPreference: Array<{name,aidType}>, truncated: number}>}
 */
export async function collectAcceptedFundingSources(db, { profileId, education = null } = {}) {
  const out = { sources: [], declinedByPreference: [], truncated: 0 }
  if (!db || !profileId) return out

  // The profile's aid-type preference (loaded here so a caller cannot forget).
  let edu = education
  if (!edu) {
    try {
      const row = await db.prepare(
        "SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'education' LIMIT 1",
      ).get(String(profileId))
      edu = row?.data ? (typeof row.data === 'object' ? row.data : JSON.parse(row.data)) : {}
    } catch { edu = {} }
  }

  const seen = new Set()
  const push = (name, amount, sponsor, source) => {
    const clean = String(name || '').trim()
    if (!clean) return
    const key = clean.toLowerCase()
    if (seen.has(key)) return
    // The household's own aid-type decision governs the WRITE side too: a
    // declined kind is never reported to a third party on their behalf.
    const verdict = evaluateAwardAgainstPreferences({ title: clean }, edu)
    if (!verdict.accepted) {
      out.declinedByPreference.push({ name: clean, aidType: verdict.aidType })
      seen.add(key)
      return
    }
    seen.add(key)
    out.sources.push({ name: clean, amount: num(amount), sponsor: sponsor || null, source, aidType: verdict.aidType })
  }

  // 1) The pipeline — the canonical record of what was actually won.
  try {
    const rows = await db.prepare(
      `SELECT title, funder, amount_awarded, amount_requested, status
         FROM grants
        WHERE profile_id = ?
          AND (LOWER(COALESCE(status,'')) = 'awarded' OR COALESCE(amount_awarded, 0) > 0)`,
    ).all(String(profileId))
    for (const r of rows || []) {
      push(r.title, r.amount_awarded ?? r.amount_requested, r.funder, 'pipeline')
    }
  } catch (err) {
    // A schema mismatch must never silence the whole write side.
    log.warn('accepted_sources_pipeline_read_failed', { profileId: String(profileId), error: err?.message })
  }

  // 2) Awards previously imported FROM a school portal. Reporting one back to
  //    the SAME portal is redundant but harmless (the caller dedupes by portal),
  //    and reporting it to a DIFFERENT portal is exactly right — that school
  //    does need to know about the other school's award.
  try {
    const row = await db.prepare(
      "SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'university_applications' LIMIT 1",
    ).get(String(profileId))
    const uni = row?.data ? (typeof row.data === 'object' ? row.data : JSON.parse(row.data)) : {}
    for (const app of Array.isArray(uni?.applications) ? uni.applications : []) {
      for (const a of Array.isArray(app?.imported_portal_awards) ? app.imported_portal_awards : []) {
        push(a?.title || a?.award_name, a?.amount, a?.provider_name, 'portal_import')
      }
    }
  } catch { /* section absent — pipeline alone is a valid answer */ }

  if (out.sources.length > MAX_SOURCES) {
    out.truncated = out.sources.length - MAX_SOURCES
    out.sources = out.sources.slice(0, MAX_SOURCES)
  }
  return out
}

export default { collectAcceptedFundingSources }
