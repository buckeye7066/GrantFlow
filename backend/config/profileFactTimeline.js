/**
 * profileFactTimeline.js — WHEN a profile fact is true.
 *
 * Every geographic and institutional fact the matcher reads used to be
 * timeless: "attended X" authorized an award for students ENTERING X, a city
 * the applicant once lived in scored as where they live now, and a tag typed
 * as a high-school senior kept matching senior-only awards a year after
 * graduation. Owner rule (2026-09-07, one Tennessee student's Discover page):
 * the relatable gate must know what is true NOW (she is at MTSU, a transfer
 * student), what WAS true (she was a senior at her high school, she lived in
 * Cleveland, TN), and what is true BY ORIGIN (born in Chattanooga, half
 * Russian) — because funders anchor awards to each of those differently.
 *
 * This module is the single derivation of that timeline. It is a REGISTRY
 * (`TIMELINE_INSTITUTION_FIELDS`, `TIMELINE_PLACE_FIELDS`) over declared
 * fields only — never prose, never tags (a `tags: ["High School Senior"]`
 * entry is exactly the stale claim this exists to outrank). Status is decided
 * by the field's own status text or year; silence keeps the field's declared
 * default and is never promoted to a stronger claim.
 *
 *   status 'current'  — true today (current institution, current residence)
 *   status 'entering' — committed to, starting (a committed application)
 *   status 'past'     — was true, is not (graduated school, former residence)
 *   status 'origin'   — permanent (birthplace, heritage)
 */

import { deriveStageOfLife } from './profileDerivedFacts.js'
import { cleanInstitutionName, resolveAspirationalInstitutions } from './profileInstitutions.js'

export const FACT_STATUS = Object.freeze({
  CURRENT: 'current',
  ENTERING: 'entering',
  PAST: 'past',
  ORIGIN: 'origin',
  /** Named as a target / applied to, not attended: an aspiration, never a tie. */
  PROSPECTIVE: 'prospective',
})

/** A status text that says the relationship is OVER. */
const PAST_STATUS_RX = /\b(?:graduat|complet|former|alumn|attended|earned|finished|transferred\s+(?:from|out)|withdrew|left|previous)/i
/** A status text that says the relationship is LIVE or STARTING. */
const ENTERING_STATUS_RX = /\b(?:incoming|entering|admitted|committed|accepted|starting)\b/i

const STATE_NAMES = Object.freeze({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
  'puerto rico': 'PR',
})
const STATE_CODES = new Set(Object.values(STATE_NAMES))

function obj(v) {
  if (!v) return {}
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : {} } catch { return {} }
  }
  return typeof v === 'object' && !Array.isArray(v) ? v : {}
}

function list(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p } catch { /* comma list */ }
    return v.split(/[,;/]|\band\b/i).map((s) => s.trim()).filter(Boolean)
  }
  return []
}

function str(v) {
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim()
}

/** Normalize a state name or code to a 2-letter code, else null. */
export function normalizeStateCode(value) {
  const s = str(value)
  if (!s) return null
  const up = s.toUpperCase()
  if (STATE_CODES.has(up)) return up
  return STATE_NAMES[s.toLowerCase()] ?? null
}

/**
 * Parse a free-text place — "Cleveland, TN 37312", "Bradley County, TN",
 * "Chattanooga, Tennessee", "Tennessee" — into {city, county, state, zip}.
 * Anything it cannot read is null; it never guesses a state from a city.
 */
export function parsePlace(value) {
  const text = str(value).replace(/\s+/g, ' ')
  if (!text) return null
  const out = { city: null, county: null, state: null, zip: null, raw: text }
  const zip = text.match(/\b(\d{5})(?:-\d{4})?\b/)
  if (zip) out.zip = zip[1]
  // Drop a ZIP, then any year or year range ("(2008-2015)", "2010–present"):
  // a residence entry often carries when, which is not part of where.
  const body = text
    .replace(/\b\d{5}(?:-\d{4})?\b/, '')
    .replace(/\b(?:19|20)\d{2}\s*(?:[-–—to]+\s*(?:(?:19|20)\d{2}|present|now))?\b/gi, '')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*,/g, ',')
    .trim()
  const parts = body.split(',').map((p) => p.trim()).filter(Boolean)
  // The LAST comma part that is a state wins; everything before it is the place.
  let placeParts = parts
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const code = normalizeStateCode(parts[i].replace(/\b(?:usa|us|united states)\b/i, '').trim())
    if (code) { out.state = code; placeParts = parts.slice(0, i); break }
  }
  if (!out.state && parts.length === 1) {
    const code = normalizeStateCode(parts[0])
    if (code) { out.state = code; placeParts = [] }
  }
  const place = placeParts.join(', ').trim()
  if (place) {
    const county = place.match(/^(.+?)\s+(?:county|parish|borough)$/i)
    if (county) out.county = county[1].toLowerCase()
    else out.city = place.toLowerCase()
  }
  if (!out.city && !out.county && !out.state && !out.zip) return null
  return out
}

/** Institution fields with the STATUS each declares by default. */
export const TIMELINE_INSTITUTION_FIELDS = Object.freeze([
  Object.freeze({
    id: 'education.current_institution',
    kind: 'college',
    read: (s) => [{ name: obj(s.education).current_institution, status: FACT_STATUS.CURRENT }],
  }),
  Object.freeze({
    id: 'basic_information.current_school',
    kind: 'college',
    read: (s) => [{ name: obj(s.basic_information).current_school, status: FACT_STATUS.CURRENT }],
  }),
  Object.freeze({
    id: 'university_applications.applications[status=committed].name',
    kind: 'college',
    read: (s) => {
      const apps = obj(s.university_applications).applications
      return Array.isArray(apps)
        ? apps
          .filter((a) => String(a?.status ?? '').toLowerCase() === 'committed')
          .map((a) => ({ name: a?.name, status: FACT_STATUS.ENTERING }))
        : []
    },
  }),
  Object.freeze({
    // One object or an array of {name, status, type}. The STATUS TEXT decides:
    // "Graduated May 2026" is past; "incoming"/"committed" is entering;
    // anything else keeps the attendance default (current).
    id: 'education.schools',
    kind: 'school',
    read: (s) => {
      const raw = obj(s.education).schools
      const entries = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
      return entries.map((e) => {
        const status = str(e?.status)
        const kind = /high\s*school|secondary/i.test(`${e?.type ?? ''} ${e?.name ?? ''}`) ? 'high_school' : 'college'
        return {
          name: e?.name,
          kind,
          status: PAST_STATUS_RX.test(status)
            ? FACT_STATUS.PAST
            : ENTERING_STATUS_RX.test(status) ? FACT_STATUS.ENTERING : FACT_STATUS.CURRENT,
        }
      })
    },
  }),
  Object.freeze({
    // Declared high school + graduation year. Past once the class has
    // graduated; current while the profile's derived stage is still
    // pre-baccalaureate and the year has not passed.
    id: 'education.high_school_name',
    kind: 'high_school',
    read: (s, { now, stage }) => {
      const edu = obj(s.education)
      const name = edu.high_school_name
      if (!str(name)) return []
      const year = Number.parseInt(String(edu.high_school_graduation_year ?? ''), 10)
      let status = FACT_STATUS.CURRENT
      if (Number.isFinite(year)) {
        // A June graduation: the class of the current year has graduated by
        // July; earlier years are unambiguously past.
        if (year < now.getFullYear() || (year === now.getFullYear() && now.getMonth() >= 6)) status = FACT_STATUS.PAST
      } else if (stage === 'undergraduate' || stage === 'graduate_student') {
        status = FACT_STATUS.PAST
      }
      return [{ name, kind: 'high_school', status }]
    },
  }),
])

/** Place fields with the STATUS each declares. */
export const TIMELINE_PLACE_FIELDS = Object.freeze([
  Object.freeze({
    id: 'basic_information.location',
    role: 'residence',
    read: (s) => {
      const basic = obj(s.basic_information)
      const loc = obj(basic.location)
      const state = normalizeStateCode(loc.state || basic.state)
      const city = str(loc.city || basic.city).toLowerCase() || null
      const county = str(loc.county || basic.county).replace(/\s+county$/i, '').toLowerCase() || null
      const zip = str(loc.zip_code || loc.zip) || null
      if (!state && !city && !county) return []
      return [{ city, county, state, zip, status: FACT_STATUS.CURRENT }]
    },
  }),
  Object.freeze({
    // Free text: "Cleveland, TN (2008-2026)" or an object {city, state, from, to}.
    id: 'basic_information.previous_residences',
    role: 'residence',
    read: (s) => {
      const raw = obj(s.basic_information).previous_residences
      const entries = Array.isArray(raw) ? raw : list(raw)
      return entries.map((e) => {
        const p = typeof e === 'string' ? parsePlace(e) : e && typeof e === 'object'
          ? { city: str(e.city).toLowerCase() || null, county: str(e.county).toLowerCase() || null, state: normalizeStateCode(e.state), zip: null }
          : null
        return p ? { ...p, status: FACT_STATUS.PAST } : null
      }).filter(Boolean)
    },
  }),
  Object.freeze({
    id: 'basic_information.birthplace',
    role: 'birthplace',
    read: (s) => {
      const p = parsePlace(obj(s.basic_information).birthplace)
      return p ? [{ ...p, status: FACT_STATUS.ORIGIN }] : []
    },
  }),
])

/** Heritage fields (origin facts). Boolean `<x>_heritage` flags are read by name. */
export const TIMELINE_HERITAGE_FIELDS = Object.freeze([
  Object.freeze({ id: 'demographics.heritage', read: (s) => list(obj(s.demographics).heritage) }),
  Object.freeze({ id: 'demographics.ethnicity', read: (s) => list(obj(s.demographics).ethnicity) }),
  Object.freeze({
    id: 'demographics.*_heritage',
    read: (s) => Object.entries(obj(s.demographics))
      .filter(([k, v]) => /_heritage$/.test(k) && v === true)
      .map(([k]) => k.replace(/_heritage$/, '').replace(/_/g, ' ')),
  }),
])

/** Common demonym → root so "Russian" (profile) meets "of Russian descent" (award). */
const DEMONYM_ROOTS = Object.freeze({
  russian: 'russia', polish: 'poland', ukrainian: 'ukraine', irish: 'ireland', italian: 'italy',
  greek: 'greece', armenian: 'armenia', german: 'germany', jewish: 'jewish', hispanic: 'hispanic',
  latino: 'hispanic', latina: 'hispanic', appalachian: 'appalachia', chinese: 'china',
  korean: 'korea', japanese: 'japan', vietnamese: 'vietnam', filipino: 'philippines',
  indian: 'india', mexican: 'mexico', cuban: 'cuba', african: 'africa', scottish: 'scotland',
  welsh: 'wales', french: 'france', dutch: 'netherlands', norwegian: 'norway', swedish: 'sweden',
  finnish: 'finland', danish: 'denmark', hungarian: 'hungary', czech: 'czech', lebanese: 'lebanon',
  portuguese: 'portugal', brazilian: 'brazil', puerto: 'puerto rico', native: 'native american',
  lithuanian: 'lithuania', romanian: 'romania', serbian: 'serbia', croatian: 'croatia',
  slovak: 'slovakia', slovenian: 'slovenia', turkish: 'turkey', persian: 'iran', iranian: 'iran',
  nigerian: 'nigeria', ethiopian: 'ethiopia', haitian: 'haiti', jamaican: 'jamaica',
})

/** Normalize a heritage word or demonym to a comparable root. */
export function heritageRoot(value) {
  const w = str(value).toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!w) return null
  const first = w.split(/[\s-]/)[0]
  if (DEMONYM_ROOTS[first]) return DEMONYM_ROOTS[first]
  if (Object.values(DEMONYM_ROOTS).includes(w)) return w
  // Fallback: strip common demonym suffixes and compare stems.
  return w.replace(/(?:ian|ean|ese|ish|ic|an|er|i)$/, '')
}

const INSTITUTION_GENERIC = new Set(['the', 'of', 'at', 'and', 'university', 'college', 'community', 'school', 'high', 'institute', 'academy', 'campus'])

/** Bidirectional distinctive-token equality on institution names. */
export function sameInstitutionName(a, b) {
  const tokens = (name) => new Set(
    String(name ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((t) => t && !INSTITUTION_GENERIC.has(t)),
  )
  const x = tokens(a); const y = tokens(b)
  if (x.size === 0 || y.size === 0 || x.size !== y.size) return false
  for (const t of x) if (!y.has(t)) return false
  return true
}

/**
 * Build the timeline.
 * @returns {{
 *   institutions: Array<{name, kind, status, evidence}>,
 *   residences: Array<{city, county, state, zip, status, evidence}>,
 *   birthplace: {city, county, state, status, evidence}|null,
 *   heritage: Array<{value, root, evidence}>,
 *   stage: string|null,
 * }}
 */
export function buildProfileFactTimeline(sections = {}, { now = new Date() } = {}) {
  const s = sections ?? {}
  const stage = deriveStageOfLife(s)?.value ?? null
  const institutions = []
  for (const field of TIMELINE_INSTITUTION_FIELDS) {
    let raw = []
    try { raw = field.read(s, { now, stage }) ?? [] } catch { raw = [] }
    for (const entry of raw) {
      const name = cleanInstitutionName(entry?.name)
      if (!name) continue
      const kind = entry.kind ?? field.kind
      const existing = institutions.find((i) => sameInstitutionName(i.name, name))
      if (existing) {
        // A field that says CURRENT/ENTERING outranks one that says PAST for the
        // same school only when the profile names it as current: the current
        // institution field is a stronger declaration than a schools[] status.
        if (existing.status === FACT_STATUS.PAST && entry.status !== FACT_STATUS.PAST) {
          existing.status = entry.status; existing.evidence = field.id
        }
        continue
      }
      institutions.push({ name, kind, status: entry.status, evidence: field.id })
    }
  }
  // Aspirations (target colleges, applications) are recorded so an award for
  // students ENTERING one of them is judged neutral rather than "elsewhere":
  // the profile may well enroll there. They never satisfy a current tie.
  for (const name of resolveAspirationalInstitutions(s)) {
    if (institutions.some((i) => sameInstitutionName(i.name, name))) continue
    institutions.push({ name, kind: 'college', status: FACT_STATUS.PROSPECTIVE, evidence: 'config/profileInstitutions (aspiration)' })
  }
  const residences = []
  let birthplace = null
  for (const field of TIMELINE_PLACE_FIELDS) {
    let raw = []
    try { raw = field.read(s) ?? [] } catch { raw = [] }
    for (const entry of raw) {
      const place = { city: entry.city ?? null, county: entry.county ?? null, state: entry.state ?? null, zip: entry.zip ?? null, status: entry.status, evidence: field.id }
      if (field.role === 'birthplace') { if (!birthplace) birthplace = place } else residences.push(place)
    }
  }
  const heritage = []
  for (const field of TIMELINE_HERITAGE_FIELDS) {
    let raw = []
    try { raw = field.read(s) ?? [] } catch { raw = [] }
    for (const value of raw) {
      const v = str(value)
      if (!v || /^(?:none|n\/a|unknown|not applicable)$/i.test(v)) continue
      const root = heritageRoot(v)
      if (!root || heritage.some((h) => h.root === root)) continue
      heritage.push({ value: v, root, evidence: field.id })
    }
  }
  return Object.freeze({ institutions, residences, birthplace, heritage, stage })
}

/** The profile's relationship with an institution: 'current'|'entering'|'past'|null. */
export function institutionRelationship(timeline, name) {
  const hits = (timeline?.institutions ?? []).filter((i) => sameInstitutionName(i.name, name))
  if (hits.length === 0) return null
  if (hits.some((h) => h.status === FACT_STATUS.CURRENT)) return FACT_STATUS.CURRENT
  if (hits.some((h) => h.status === FACT_STATUS.ENTERING)) return FACT_STATUS.ENTERING
  if (hits.some((h) => h.status === FACT_STATUS.PAST)) return FACT_STATUS.PAST
  return FACT_STATUS.PROSPECTIVE
}

/** The institution(s) the profile is AT or ENTERING right now (declared). */
export function currentInstitutions(timeline) {
  return (timeline?.institutions ?? [])
    .filter((i) => i.status === FACT_STATUS.CURRENT || i.status === FACT_STATUS.ENTERING)
    .map((i) => i.name)
}

/** Does a residence entry cover a parsed place (state must agree; city/county when named)? */
function residenceCovers(res, place) {
  if (!res || !place) return false
  if (place.state && res.state && place.state !== res.state) return false
  if (place.county) return Boolean(res.county) && res.county === place.county
  if (place.city) return Boolean(res.city) && res.city === place.city
  return Boolean(place.state) && res.state === place.state
}

/** The profile's relationship with a place: 'current'|'past'|null. */
export function residenceRelationship(timeline, place) {
  const res = timeline?.residences ?? []
  if (res.some((r) => r.status === FACT_STATUS.CURRENT && residenceCovers(r, place))) return FACT_STATUS.CURRENT
  if (res.some((r) => r.status === FACT_STATUS.PAST && residenceCovers(r, place))) return FACT_STATUS.PAST
  return null
}

/** Whether the profile declares heritage matching a demonym. */
export function hasHeritage(timeline, demonym) {
  const root = heritageRoot(demonym)
  if (!root) return false
  return (timeline?.heritage ?? []).some((h) => h.root === root)
}

export default {
  FACT_STATUS,
  TIMELINE_INSTITUTION_FIELDS,
  TIMELINE_PLACE_FIELDS,
  TIMELINE_HERITAGE_FIELDS,
  buildProfileFactTimeline,
  institutionRelationship,
  currentInstitutions,
  residenceRelationship,
  hasHeritage,
  parsePlace,
  normalizeStateCode,
  heritageRoot,
  sameInstitutionName,
}
