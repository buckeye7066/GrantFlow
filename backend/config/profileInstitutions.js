/**
 * profileInstitutions.js — SINGLE SOURCE OF TRUTH for "which school does this
 * profile ATTEND", and for "does this catalog row belong to that school".
 *
 * THE DEFECT THIS EXISTS FOR (institution_recall_miss, 21/21 Amy cohort days):
 * a student's own institution's aid never reached the student. Measured
 * read-only in prod 2026-08-01: the catalog held **52 active Middle Tennessee
 * State University rows** (Peggy Perry Belcher Scholarship Fund, MTSU Guaranteed
 * Scholarship, Buchanan Fellowship, …) and **ZERO of them carried a match row
 * for ANY profile** — including Anastasia White, whose
 * `education.current_institution` IS "Middle Tennessee State University".
 * Meanwhile Wayne County Community College District (MICHIGAN) scholarships were
 * cross-matched onto **28 profiles** at scores 3–4, including nonprofits and a
 * biolab. Both ends of one defect: the profile's own school is invisible while
 * an arbitrary out-of-state school floods the fleet.
 *
 * THE ENGINE WAS NEVER THE PROBLEM. Replaying the REAL canonical engine
 * (`services/matchEngine.computeMatchDecision`) on the real prod pair
 * (Anastasia + "Peggy Perry Belcher Scholarship Fund") returns
 * **ACCEPT, score 100, "Matches 70 of the profile's 70 data points"**. The pair
 * is never SCORED, because `profile_opportunity_matches` is a ROLLING SNAPSHOT:
 * `crawlerOsPersistenceCore.persistRun` DELETEs a profile's
 * `crawler-os`/`crawler-os-xmatch` rows and re-inserts only what THAT run
 * re-found. Institution scholarships are reachable only through the open-web
 * lane keyed on the school's NAME, so any registry-only run of that profile
 * (web lane off / rate-limited / no hits) erases them, and nothing ever looks
 * at the surviving catalog row again. Fleet-wide symptom, same measurement:
 * `source='web_search'` holds **7,645 active catalog rows and only 172 have
 * EVER carried a match row (2.2%)**.
 *
 * THE ATTENDANCE LINK IS THE GATE, AND IT IS NARROW ON PURPOSE. Admitting all
 * university rows to every profile would trade this blind spot for a
 * false-positive flood (exactly the mistake the farm-lane fix caught in itself).
 * Two rules hold:
 *
 *   1. ATTENDANCE, NOT ASPIRATION. Only fields that assert the profile is (or
 *      has committed to) BEING at the school count — `ATTENDANCE_FIELDS`.
 *      `education.target_colleges` is deliberately ASPIRATION: Anastasia lists
 *      NINETEEN target colleges, and admitting all nineteen schools' aid is the
 *      flood. Aspiration fields still seed discovery QUERIES (that is what
 *      `crawlerOsPersistenceCore.extractEducationEmployment` uses them for) —
 *      they just never authorize a match.
 *
 *   2. THE BAR IS THE WHOLE NAME, NOT ONE WORD (the Yana-lead rule, one door
 *      over). `opportunitySponsoredByInstitution` requires the DISTINCTIVE
 *      token sets of the two names to be EQUAL — bidirectional, so neither
 *      side may carry a token the other cannot explain. One shared word is a
 *      coincidence: "Wayne State University" and "Wayne County Community
 *      College District" share `wayne`; "Ohio State University" and "Ohio
 *      University" are DIFFERENT REAL SCHOOLS and differ only by `state`, which
 *      is why `state` is NOT a generic word here. Do NOT re-weaken this to
 *      `.some()` or to a substring test.
 *
 * This module authorizes the engine to LOOK at a pair. It never decides the
 * pair: `services/matchEngine.js` stays the sole decision authority, and a
 * REJECT is still a REJECT.
 */

/**
 * Words that carry no institutional identity. `state`, `community`, `technical`
 * and `district` are deliberately ABSENT — they are exactly what distinguishes
 * one real school from another ("Ohio University" ≠ "Ohio State University",
 * "Wayne State University" ≠ "Wayne County Community College District").
 */
export const GENERIC_INSTITUTION_WORDS = Object.freeze(
  new Set(['the', 'of', 'at', 'and', 'a', 'an', 'university', 'universities', 'college', 'colleges', 'school', 'institute', 'institution', 'system', 'campus']),
)

/**
 * REGISTRY — every profile field that can name a school, and whether it asserts
 * ATTENDANCE (authorizes a match) or ASPIRATION (seeds queries only).
 *
 * `read` receives the profile's SECTIONS map and returns names (any shape).
 * A totality test asserts every entry is consulted by both consumers, so a new
 * field cannot silently fall out of discovery seeding or out of the boot sweep.
 */
export const PROFILE_INSTITUTION_FIELDS = Object.freeze([
  Object.freeze({
    id: 'education.current_institution',
    kind: 'attendance',
    read: (s) => [obj(s.education).current_institution],
  }),
  Object.freeze({
    id: 'basic_information.current_school',
    kind: 'attendance',
    read: (s) => [obj(s.basic_information).current_school],
  }),
  Object.freeze({
    id: 'university_applications.applications[status=committed].name',
    kind: 'attendance',
    read: (s) => {
      const apps = obj(s.university_applications).applications
      return Array.isArray(apps)
        ? apps.filter((a) => String(a?.status ?? '').toLowerCase() === 'committed').map((a) => a?.name)
        : []
    },
  }),
  Object.freeze({
    id: 'education.schools.name',
    kind: 'attendance',
    read: (s) => [obj(s.education)?.schools?.name],
  }),
  Object.freeze({
    id: 'university_applications.applications[*].name',
    kind: 'aspiration',
    read: (s) => {
      const apps = obj(s.university_applications).applications
      return Array.isArray(apps) ? apps.map((a) => a?.name) : []
    },
  }),
  Object.freeze({
    id: 'education.target_colleges',
    kind: 'aspiration',
    read: (s) => (Array.isArray(obj(s.education).target_colleges) ? obj(s.education).target_colleges : []),
  }),
])

/** Max ATTENDED institutions honored per profile (a person attends very few). */
export const MAX_ATTENDED_INSTITUTIONS = 3

/**
 * Max ASPIRATION institutions read per profile. Deliberately much larger than
 * `MAX_ATTENDED_INSTITUTIONS`: this set is only ever used to REFUSE a link, so
 * truncating it would silently let an aspiration row through the very guard it
 * exists to enforce. Anastasia White lists NINETEEN target colleges in prod.
 */
export const MAX_ASPIRATIONAL_INSTITUTIONS = 60

function obj(v) {
  if (!v) return {}
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {} } catch { return {} }
  }
  return typeof v === 'object' ? v : {}
}

/**
 * Clean a free-text institution / employer name. Rejects empties, "none"/"n/a"
 * placeholders and absurdly long blobs. (Behavior preserved verbatim from
 * `crawlerOsPersistenceCore.cleanName`, which now imports this.)
 */
export function cleanInstitutionName(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  if (!s || s.length < 3 || s.length > 90) return null
  if (/^(none|n\/a|na|unknown|tbd|null)$/i.test(s)) return null
  return s
}

/** Ordered, de-duplicated school names from the registry, filtered by kind. */
function readInstitutions(sections = {}, kinds) {
  const out = []
  for (const field of PROFILE_INSTITUTION_FIELDS) {
    if (!kinds.includes(field.kind)) continue
    let raw = []
    try { raw = field.read(sections ?? {}) ?? [] } catch { raw = [] }
    for (const value of raw) {
      const name = cleanInstitutionName(value)
      if (name && !out.some((s) => s.toLowerCase() === name.toLowerCase())) out.push(name)
    }
  }
  return out
}

/**
 * Schools the profile ATTENDS or has COMMITTED to. This is the ONLY set that may
 * authorize an institution-aid match. Bounded — a person attends very few.
 */
export function resolveAttendedInstitutions(sections = {}, { limit = MAX_ATTENDED_INSTITUTIONS } = {}) {
  return readInstitutions(sections, ['attendance']).slice(0, Math.max(0, limit))
}

/**
 * Every school the profile names, attendance first then aspiration — the
 * discovery QUERY seed set. Aspiration is fine here: a target college is a real
 * thing to search for; it just may not authorize a match.
 */
export function resolveSeedInstitutions(sections = {}, { limit = MAX_ATTENDED_INSTITUTIONS } = {}) {
  return readInstitutions(sections, ['attendance', 'aspiration']).slice(0, Math.max(0, limit))
}

/**
 * Schools the profile only ASPIRES to (target colleges, uncommitted
 * applications). This set NEVER authorizes anything — it exists so a second
 * door cannot silently re-open the one `resolveAttendedInstitutions` closed.
 *
 * WHY IT IS NEEDED. `enforceInstitutionAidLinkage` refuses aspiration by
 * asking only for ATTENDED schools. But a catalog row can also name the
 * profile it was discovered for (`funding_opportunities.profile_id`), and in
 * prod 2026-08-01 that column carried 107 school-sponsored locator rows minted
 * from ONE student's nineteen `target_colleges` — Harvard, Oberlin, Michigan,
 * Penn State, Seton Hall … Linking on provenance alone would have re-admitted
 * exactly the aspiration set #1089 excluded, through a different door. So
 * `enforceProfileDiscoveredCatalogLinkage` reads this list and refuses any row
 * an aspiration school sponsors that no ATTENDED school also sponsors.
 */
export function resolveAspirationalInstitutions(
  sections = {},
  { limit = MAX_ASPIRATIONAL_INSTITUTIONS } = {},
) {
  return readInstitutions(sections, ['aspiration']).slice(0, Math.max(0, limit))
}

/** Distinctive (identity-bearing) lowercase tokens of an institution name. */
export function institutionDistinctiveTokens(name) {
  return new Set(
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0 && !GENERIC_INSTITUTION_WORDS.has(t)),
  )
}

/**
 * Does this catalog row's SPONSOR name the same institution?
 *
 * BIDIRECTIONAL distinctive-token EQUALITY. One-directional coverage is not
 * enough: "Tennessee State University" ⊂ "Middle Tennessee State University"
 * would admit a different school's aid. Evidence is the SPONSOR only — title
 * prose and URL hosts are how a class fix decays into a denylist, and a
 * scholarship LISTED on a school's page is not necessarily that school's award.
 */
export function opportunitySponsoredByInstitution(institution, row) {
  const want = institutionDistinctiveTokens(institution)
  if (want.size === 0) return false
  const got = institutionDistinctiveTokens(row?.sponsor)
  if (got.size === 0) return false
  if (want.size !== got.size) return false
  for (const token of want) if (!got.has(token)) return false
  return true
}

/**
 * SQL LIKE patterns that are a deliberate SUPERSET of the rows an institution
 * could sponsor, so candidate discovery is a PREDICATE and never a post-LIMIT
 * JS filter (the #944 "green while doing nothing" class). The longest
 * distinctive token is the anchor; `opportunitySponsoredByInstitution` then
 * adjudicates every returned row.
 */
export function institutionSponsorLikePattern(institution) {
  const tokens = [...institutionDistinctiveTokens(institution)].sort((a, b) => b.length - a.length)
  const anchor = tokens.find((t) => t.length >= 4) ?? tokens[0]
  return anchor ? `%${anchor}%` : null
}

export default {
  GENERIC_INSTITUTION_WORDS,
  PROFILE_INSTITUTION_FIELDS,
  MAX_ATTENDED_INSTITUTIONS,
  MAX_ASPIRATIONAL_INSTITUTIONS,
  cleanInstitutionName,
  resolveAttendedInstitutions,
  resolveSeedInstitutions,
  resolveAspirationalInstitutions,
  institutionDistinctiveTokens,
  opportunitySponsoredByInstitution,
  institutionSponsorLikePattern,
}
