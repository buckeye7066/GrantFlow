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
      out.push({ name, status: app?.status || null, source: 'university_applications' })
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
      out.push({ name, status: 'planning', source: 'target_colleges' })
    }
  }

  return out
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

  // Score: status rank + bonus for being in KNOWN_SCHOOLS (so we have real URLs).
  const scored = apps.map((app) => {
    const known = getKnownSchool(app.name)
    return {
      ...app,
      known,
      score: rankStatus(app.status) + (known ? 10 : 0),
    }
  })

  scored.sort((a, b) => b.score - a.score)
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
