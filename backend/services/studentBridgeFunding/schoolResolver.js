/**
 * studentBridgeFunding/schoolResolver.js
 *
 * Pick the BEST target school for a student profile so per-school templates
 * (Dean of Students Emergency Fund, MT One Stop equivalents, off-campus
 * housing portal) can be expanded against real institutional URLs.
 *
 * Selection priority (high → low):
 *   1. university_applications.applications[] with status enrolled / accepted
 *   2. university_applications.applications[] with status committed / deposited
 *   3. university_applications.applications[] with status applied / planning
 *      (first known school wins; first unknown loses to a later known one)
 *   4. education.target_colleges[] (string list — first known school wins)
 *
 * The selected school is enriched with `getKnownSchool()` data when
 * available so callers see {city,state,county,fafsaCode,portals}. Unknown
 * schools still flow through with their raw name + a synthetic `portals`
 * object so generic-school templates can still expand against the school
 * website (passed by the user) when present.
 */

import { KNOWN_SCHOOLS, getKnownSchool } from '../shared/data/knownSchools.js'

const STATUS_RANK = {
  enrolled: 100,
  attending: 100,
  current: 100,
  matriculated: 100,
  committed: 90,
  deposited: 90,
  accepted: 80,
  admitted: 80,
  applied: 50,
  in_review: 45,
  pending: 45,
  planning: 30,
  considering: 20,
  prospective: 15,
  declined: -10,
  rejected: -100,
  withdrawn: -100,
}

function rankStatus(status) {
  if (!status) return 25 // unknown but present
  const norm = String(status).trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(STATUS_RANK, norm)) return STATUS_RANK[norm]
  return 25
}

/**
 * Lightweight college-town → county lookup.
 * Used only when the school's KNOWN_SCHOOLS entry doesn't carry a county.
 *
 * Add new entries as needed — keep keys lower-case and include state.
 */
const COLLEGE_TOWN_COUNTY = {
  'middle tennessee state university|tn': { city: 'Murfreesboro', county: 'Rutherford County' },
  'austin peay state university|tn': { city: 'Clarksville', county: 'Montgomery County' },
  'university of tennessee|tn': { city: 'Knoxville', county: 'Knox County' },
  'university of tennessee knoxville|tn': { city: 'Knoxville', county: 'Knox County' },
  'university of tennessee chattanooga|tn': { city: 'Chattanooga', county: 'Hamilton County' },
  'university of memphis|tn': { city: 'Memphis', county: 'Shelby County' },
  'east tennessee state university|tn': { city: 'Johnson City', county: 'Washington County' },
  'tennessee tech|tn': { city: 'Cookeville', county: 'Putnam County' },
  'tennessee state university|tn': { city: 'Nashville', county: 'Davidson County' },
  'belmont university|tn': { city: 'Nashville', county: 'Davidson County' },
  'lipscomb university|tn': { city: 'Nashville', county: 'Davidson County' },
  'vanderbilt university|tn': { city: 'Nashville', county: 'Davidson County' },
  'trevecca nazarene university|tn': { city: 'Nashville', county: 'Davidson County' },
  'lee university|tn': { city: 'Cleveland', county: 'Bradley County' },
  'cleveland state community college|tn': { city: 'Cleveland', county: 'Bradley County' },
  'carson-newman university|tn': { city: 'Jefferson City', county: 'Jefferson County' },
  'centre college|ky': { city: 'Danville', county: 'Boyle County' },
  'university of central florida|fl': { city: 'Orlando', county: 'Orange County' },
  'university of new haven|ct': { city: 'West Haven', county: 'New Haven County' },
  'pennsylvania state university|pa': { city: 'University Park', county: 'Centre County' },
  'penn state university|pa': { city: 'University Park', county: 'Centre County' },
  'oberlin college|oh': { city: 'Oberlin', county: 'Lorain County' },
  'christian brothers university|tn': { city: 'Memphis', county: 'Shelby County' },
  'seton hall university|nj': { city: 'South Orange', county: 'Essex County' },
  'harvard university|ma': { city: 'Cambridge', county: 'Middlesex County' },
}

function resolveCollegeTown(schoolName, state) {
  if (!schoolName || !state) return null
  const key = `${String(schoolName).trim().toLowerCase()}|${String(state).trim().toLowerCase()}`
  return COLLEGE_TOWN_COUNTY[key] || null
}

/**
 * Build a unified ApplicationsList from both `university_applications.applications`
 * and `education.target_colleges` (legacy string-only list).
 */
function buildApplicationsList(sections = {}) {
  const out = []
  const seen = new Set()

  const universityApps = sections?.university_applications?.applications
  if (Array.isArray(universityApps)) {
    for (const app of universityApps) {
      const name = String(app?.name || '').trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        name,
        status: app?.status || null,
        source: 'university_applications',
        // A real application row is at least a DECLARED relationship with the
        // school. Whether it is ATTENDANCE is decided by its status below.
        aspirational: false,
      })
    }
  }

  const targets = sections?.education?.target_colleges
  if (Array.isArray(targets)) {
    for (const raw of targets) {
      const name = String(raw || '').trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      // ASPIRATION, NEVER ATTENDANCE. `education.target_colleges` is the
      // canonical aspiration field (backend/config/profileInstitutions.js tags
      // it `aspiration`, and one real prod student lists NINETEEN of them).
      // The canonical rule is explicit: aspiration seeds discovery QUERIES and
      // never authorizes an institution-specific claim. These templates mint
      // per-school funding pointers (Dean of Students Emergency Fund, the
      // school's housing portal), so letting an aspirational entry win produces
      // a funding source at a school the student does not attend.
      out.push({ name, status: 'planning', source: 'target_colleges', aspirational: true })
    }
  }

  return out
}

/** Statuses that assert the student is AT (or committed to) the school. */
const ATTENDANCE_STATUS_MIN_RANK = STATUS_RANK.committed // 90 — committed/deposited/enrolled/attending

function isAttendanceAuthorized(app) {
  if (!app || app.aspirational) return false
  return rankStatus(app.status) >= ATTENDANCE_STATUS_MIN_RANK
}

/**
 * Pick the top-ranked school AND attach KNOWN_SCHOOLS metadata when we have it.
 *
 * Returns null if no school can be picked.
 */
export function resolveTargetSchool({ profile, sections = {} }) {
  void profile
  const apps = buildApplicationsList(sections)
  if (apps.length === 0) return null

  // PROVENANCE OUTRANKS CONVENIENCE. The old score was
  // `rankStatus(status) + (known ? 10 : 0)`, so KNOWN-ness — which only means
  // "we happen to have curated URLs for this school" — could beat a real
  // application: a KNOWN aspirational `target_colleges` entry scored 30+10=40
  // and outranked a status-less row in `university_applications` (25), i.e. an
  // actual application the student filed. Provenance is now the PRIMARY key and
  // the KNOWN_SCHOOLS bonus is only a tie-breaker WITHIN a tier.
  const scored = apps.map((app) => {
    const known = getKnownSchool(app.name)
    return {
      ...app,
      known,
      attendance: isAttendanceAuthorized(app),
      score: rankStatus(app.status),
      knownBonus: known ? 1 : 0,
    }
  })

  scored.sort((a, b) =>
    (Number(b.attendance) - Number(a.attendance)) ||
    (Number(a.aspirational === true) - Number(b.aspirational === true)) ||
    (b.score - a.score) ||
    (b.knownBonus - a.knownBonus))
  const winner = scored[0]
  if (!winner) return null

  const known = winner.known
  const state = (known?.state || '').toUpperCase() || null
  const town = resolveCollegeTown(known?.name || winner.name, state) || null

  return {
    name: known?.name || winner.name,
    rawName: winner.name,
    status: winner.status,
    known: known || null,
    state,
    city: town?.city || null,
    county: town?.county || null,
    fafsaCode: known?.fafsaCode || null,
    website: known?.website || null,
    portals: known?.portals || null,
    selectionScore: winner.score,
    selectionSource: winner.source,
    candidatesConsidered: scored.length,
    // HONEST PROVENANCE OF THE PICK. `attendance:true` means the profile
    // declared it is AT (or committed to) this school; `aspirational:true`
    // means the ONLY evidence is `education.target_colleges`, which the
    // canonical rule says may seed queries but never authorize an
    // institution-specific claim. A consumer that mints a per-school funding
    // pointer must check this — see the cross-batch note for
    // studentBridgeFunding/expander.js.
    attendance: winner.attendance === true,
    aspirational: winner.aspirational === true,
  }
}

/**
 * Test export: full ranked list (helpful for unit tests + admin debugging).
 */
export function rankCandidateSchools({ profile, sections = {} }) {
  void profile
  const apps = buildApplicationsList(sections)
  return apps.map((app) => {
    const known = getKnownSchool(app.name)
    return {
      ...app,
      known: known ? { name: known.name, state: known.state } : null,
      rank: rankStatus(app.status) + (known ? 10 : 0),
    }
  })
}

/** Re-export so consumers don't need a second import. */
export { KNOWN_SCHOOLS }
