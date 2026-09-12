/**
 * temporalRelatability.js — the TEMPORAL half of the relatable gate.
 *
 * A funder anchors an award to a moment in the applicant's life:
 *   "graduating seniors from service-area high schools entering X" — NOW
 *   "students currently enrolled at X"                             — NOW
 *   "residents of Bradley County"                                   — NOW
 *   "alumni of X" / "graduates of X"                                — PAST is enough
 *   "current or former residents" / "grew up in"                    — PAST is enough
 *   "born in Chattanooga" / "natives of Tennessee"                  — ORIGIN
 *   "of Russian descent" / "Polish-American students"               — ORIGIN
 *
 * The relatable gate read every such tie as timeless, so a Tennessee student
 * who GRADUATED from her community college in May kept matching that
 * college's "entering freshmen" awards in September (owner report
 * 2026-09-07), while nothing could reach an alumni award from her high school
 * or a heritage award she qualifies for by birth.
 *
 * THE RULE. A row's own words declare an ANCHOR CLASS (registry below) and a
 * SUBJECT (an institution, a place, a demonym). The profile's fact timeline
 * (`profileFactTimeline.js`) says what its relationship with that subject IS:
 * current / entering / past / origin / none. The verdict:
 *
 *   stale        — the row requires a CURRENT tie and the profile's only tie is
 *                  PAST (provable impossibility; the engine REJECTs)
 *   elsewhere    — the row requires being enrolled at / entering institution X
 *                  and the profile DECLARES it is at institution Y, with X
 *                  named nowhere (not even as a target). "Must be admitted to
 *                  TSU" for a student who says she is at MTSU (owner rule
 *                  2026-09-07). Also: the row requires CURRENT residence in one
 *                  named county and every declared current residence provably
 *                  lies outside it ("individuals who live in Monroe County" for
 *                  a Bradley County, TN resident). A conflict, like stale.
 *   fit_current  — the row's requirement is met by a current tie
 *   fit_past     — the row honors a past tie and the profile has one
 *   fit_origin   — the row honors origin and the profile declares it
 *   unknown      — the row names a subject the profile says nothing about
 *                  (silence is neutral, never a denial)
 *   null         — the row declares no temporal anchor at all
 *
 * READ FROM THE ROW'S OWN TEXT ONLY (title, sponsor, eligibility, description).
 * It never re-reads the profile's prose; the timeline is registry-driven.
 * Negated phrases ("not limited to residents of") are skipped.
 */

import {
  buildProfileFactTimeline,
  institutionRelationship,
  currentInstitutions,
  residenceRelationship,
  hasHeritage,
  parsePlace,
  normalizeStateCode,
  FACT_STATUS,
} from './profileFactTimeline.js'

/** How a class's requirement relates to the timeline statuses. */
export const REQUIRES = Object.freeze({
  CURRENT: 'current',            // current or entering only
  PAST_OR_CURRENT: 'past_or_current',
  ORIGIN: 'origin',
})

const INSTITUTION_NAME_RX = /((?:[A-Z][\w&.'-]*\s+){0,6}(?:University|College|Institute|Academy|School)(?:\s+of\s+(?:[A-Z][\w&.'-]*\s*){1,3})?)/
const PLACE_RX = /((?:[A-Z][\w.'-]+\s?){1,4}(?:County|Parish|Borough)?(?:,\s*(?:[A-Z]{2}|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?))?)/
const NEGATION_RX = /\b(?:not|no|need not|regardless of|open to all|any|without regard to|does not require)\b[^.]{0,30}$/i
// Case-sensitive on purpose: a list continues with another CAPITALIZED place
// ("…County, or Marion County"); "Monroe County or dislocated workers" does not.
const PLACE_LIST_RX = /^\s*(?:,|\/|&|and\b|or\b)\s*(?:the\s+)?[A-Z]/
const PLACE_WIDENED_RX = /^\s*(?:(?:,|\/|&|and\b|or\b)\s*(?:the\s+)?(?:surrounding|adjacent|neighbou?ring|nearby|contiguous|other|all|any)\b|(?:area|region|metro(?:politan)?|service\s+area)\b)/i
const CLEAN_COUNTY_RX = /^[a-z][a-z .'-]*$/

/** The anchor registry. `subject` decides how the phrase's object is resolved. */
export const TEMPORAL_ANCHOR_CLASSES = Object.freeze([
  Object.freeze({
    id: 'entering_institution',
    label: 'students entering the institution',
    subject: 'institution',
    requires: REQUIRES.CURRENT,
    patterns: Object.freeze([
      /\b(?:entering|incoming|enrolling\s+at|newly\s+admitted\s+to|new\s+students?\s+(?:at|to)|first[- ]time\s+freshmen\s+(?:at|entering))\b/i,
      /\bstudents?\s+entering\b/i,
    ]),
  }),
  Object.freeze({
    id: 'current_enrollment',
    label: 'students currently enrolled at the institution',
    subject: 'institution',
    requires: REQUIRES.CURRENT,
    patterns: Object.freeze([
      /\b(?:currently\s+enrolled|enrolled\s+(?:at|in)|attending|current\s+students?|must\s+be\s+(?:a\s+)?(?:student|admitted)|continuing\s+students?)\b/i,
    ]),
  }),
  Object.freeze({
    id: 'alumni',
    label: 'alumni of the institution',
    subject: 'institution',
    requires: REQUIRES.PAST_OR_CURRENT,
    patterns: Object.freeze([/\balumn(?:i|us|a|ae)\b/i, /\bgraduates?\s+of\b/i, /\bformer\s+students?\b/i]),
  }),
  Object.freeze({
    id: 'high_school_senior',
    label: 'current high-school seniors',
    subject: 'stage',
    requires: REQUIRES.CURRENT,
    patterns: Object.freeze([
      /\bgraduating\s+(?:high[- ]school\s+)?seniors?\b/i,
      /\bhigh[- ]school\s+seniors?\b/i,
      /\bcurrent(?:ly)?\s+(?:a\s+)?high[- ]school\s+(?:senior|student)s?\b/i,
    ]),
    // A row that ALSO names college students is not senior-only.
    inclusionGuard: /\b(?:current\s+college\s+students?|undergraduates?|college\s+students?|community\s+college\s+students?|adult\s+learners?|continuing\s+students?|current\s+students?)\b/i,
  }),
  Object.freeze({
    id: 'residency',
    label: 'current residents of the place',
    subject: 'place',
    requires: REQUIRES.CURRENT,
    patterns: Object.freeze([
      /\b(?:residents?\s+of|reside\s+in|residing\s+in|living\s+in|must\s+(?:live|reside)\s+in|who\s+live\s+in|residents?\s+(?:in|within))\b/i,
    ]),
  }),
  Object.freeze({
    id: 'former_residency',
    label: 'current or former residents of the place',
    subject: 'place',
    requires: REQUIRES.PAST_OR_CURRENT,
    patterns: Object.freeze([
      /\b(?:current\s+or\s+former\s+residents?\s+of|former\s+residents?\s+of|grew\s+up\s+in|raised\s+in|hometown\s+(?:of|is))\b/i,
    ]),
  }),
  Object.freeze({
    id: 'birthplace',
    label: 'people born in the place',
    subject: 'place',
    requires: REQUIRES.ORIGIN,
    patterns: Object.freeze([/\b(?:born\s+in|natives?\s+of)\b/i]),
  }),
  Object.freeze({
    id: 'heritage',
    label: 'people of the stated heritage',
    subject: 'heritage',
    requires: REQUIRES.ORIGIN,
    patterns: Object.freeze([
      /\bof\s+([A-Za-z-]+)\s+(?:descent|heritage|ancestry|origin)\b/i,
      /\b([A-Za-z]+)[- ]american\s+(?:students?|applicants?|heritage|descent|community)\b/i,
    ]),
  }),
])

const TEXT_FIELDS = Object.freeze(['title', 'eligibility_text', 'eligibility_bullets', 'description', 'summary'])

function textOf(row, field) {
  const v = row?.[field]
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).join('. ')
  if (typeof v === 'string' && field === 'eligibility_bullets') {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map((x) => String(x ?? '')).join('. ') } catch { /* text */ }
  }
  return String(v)
}

function looksLikeInstitution(name) {
  return /\b(?:university|college|institute|academy|school)\b/i.test(String(name ?? ''))
}

/** Resolve the anchor's SUBJECT from the text after the phrase (or the sponsor). */
function resolveSubject(cls, text, matchIndex, matchLength, row) {
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + 120)
  if (cls.subject === 'institution') {
    const m = after.match(INSTITUTION_NAME_RX)
    if (m && m[1].trim().length >= 4) return { kind: 'institution', value: m[1].trim() }
    // "entering Cleveland State" with no institution noun: fall back to the
    // sponsor when the sponsor IS an institution — the audience of a school's
    // own award is that school.
    if (looksLikeInstitution(row?.sponsor)) return { kind: 'institution', value: String(row.sponsor).trim() }
    return null
  }
  if (cls.subject === 'place') {
    const m = after.match(PLACE_RX)
    if (!m) return null
    // PLACE_RX allows '.' inside a word ("St. Louis"), so a sentence-final place
    // arrives as "Monroe County." — strip the terminal punctuation first.
    const place = parsePlace(m[1].trim().replace(/[.,;:]+$/, ''))
    if (!place) return null
    // A bare capitalized word that is not a state and carries no county/state
    // qualifier is too weak to be a place claim ("residents of Our Community").
    if (!place.state && !place.county && !place.city) return null
    // A place inside a list ("Hamilton County, Bradley County, or Marion County")
    // or widened to its region ("Monroe County and surrounding counties", "the
    // Monroe County area") may include places it does not name.
    const rest = after.slice(m.index + m[0].length)
    const widened = PLACE_LIST_RX.test(rest) || PLACE_WIDENED_RX.test(rest) || /,\s*[A-Za-z .'-]+\s+(?:county|parish|borough)\b/i.test(m[1])
    return { kind: 'place', value: place, raw: m[1].trim(), ...(widened ? { widened: true } : {}) }
  }
  if (cls.subject === 'heritage') return null // captured by the pattern itself
  return { kind: 'stage', value: null }
}

/**
 * Every temporal anchor a row's own text declares.
 * @returns {Array<{classId, requires, subject, phrase, field}>}
 */
export function detectTemporalAnchors(row) {
  const anchors = []
  if (!row || typeof row !== 'object') return anchors
  for (const field of TEXT_FIELDS) {
    const text = textOf(row, field)
    if (!text) continue
    for (const cls of TEMPORAL_ANCHOR_CLASSES) {
      for (const pattern of cls.patterns) {
        const rx = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
        let m
        while ((m = rx.exec(text)) !== null) {
          const before = text.slice(Math.max(0, m.index - 40), m.index)
          if (NEGATION_RX.test(before)) continue
          if (cls.inclusionGuard && cls.inclusionGuard.test(text)) continue
          let subject
          if (cls.subject === 'heritage') {
            const demonym = m[1]
            if (!demonym || demonym.length < 3) continue
            subject = { kind: 'heritage', value: demonym }
          } else {
            subject = resolveSubject(cls, text, m.index, m[0].length, row)
            if (!subject) continue
          }
          const dup = anchors.some((a) => a.classId === cls.id && JSON.stringify(a.subject) === JSON.stringify(subject))
          if (!dup) anchors.push({ classId: cls.id, requires: cls.requires, subject, phrase: m[0], field })
        }
      }
    }
  }
  // "current or former residents of X" contains "residents of X": the broader
  // (past-honoring) class is the row's real statement, so the strict residency
  // anchor on the SAME place is dropped rather than left to outvote it.
  const formerPlaces = anchors.filter((a) => a.classId === 'former_residency').map((a) => JSON.stringify(a.subject))
  return formerPlaces.length === 0
    ? anchors
    : anchors.filter((a) => !(a.classId === 'residency' && formerPlaces.includes(JSON.stringify(a.subject))))
}

function stateName(code) {
  return code ? String(code).toUpperCase() : ''
}

function describeSubject(anchor) {
  const s = anchor.subject
  if (s.kind === 'institution') return s.value
  if (s.kind === 'heritage') return `${s.value} heritage`
  if (s.kind === 'place') {
    const p = s.value
    if (p.county) return `${p.county} County${p.state ? `, ${stateName(p.state)}` : ''}`
    if (p.city) return `${p.city}${p.state ? `, ${stateName(p.state)}` : ''}`
    return stateName(p.state)
  }
  return 'a high-school senior'
}

/**
 * Current residences that provably lie outside ONE named county: a different
 * declared county, or a different declared state when the row names one. Every
 * current residence must decide; one that states neither keeps it neutral.
 */
function currentResidencesOutsideCounty(timeline, place) {
  if (!place?.county || !CLEAN_COUNTY_RX.test(place.county) || /\bcounty\b/.test(place.county)) return []
  const current = (timeline?.residences ?? []).filter((r) => r.status === FACT_STATUS.CURRENT)
  if (current.length === 0) return []
  const outside = current.filter((r) =>
    (place.state && r.state && place.state !== r.state) || (r.county && r.county !== place.county))
  if (outside.length !== current.length) return []
  return outside.map((r) => [r.county ? `${r.county} county` : null, r.state].filter(Boolean).join(', '))
}

/** Judge one anchor against the timeline. */
function judgeAnchor(timeline, anchor) {
  const { classId, requires, subject } = anchor
  if (subject.kind === 'institution') {
    const rel = institutionRelationship(timeline, subject.value)
    if (!rel) {
      // No tie at all. If the row needs the applicant AT / ENTERING this
      // school and the profile declares it is at a different one, that is a
      // declared mismatch: "elsewhere". With no declared current school the
      // subject is simply unknown.
      if (requires === REQUIRES.CURRENT && currentInstitutions(timeline).length > 0) {
        return { fit: 'elsewhere', relationship: null, elsewhere: currentInstitutions(timeline) }
      }
      return { fit: 'unknown', relationship: null }
    }
    if (rel === FACT_STATUS.PROSPECTIVE) return { fit: 'unknown', relationship: rel }
    if (requires === REQUIRES.PAST_OR_CURRENT) return { fit: rel === FACT_STATUS.PAST ? 'fit_past' : 'fit_current', relationship: rel }
    if (rel === FACT_STATUS.PAST) return { fit: 'stale', relationship: rel }
    return { fit: 'fit_current', relationship: rel }
  }
  if (subject.kind === 'stage') {
    const stage = timeline?.stage ?? null
    if (!stage || stage === 'unclassified') return { fit: 'unknown', relationship: null }
    if (stage === 'high_school_student' || stage === 'dual_enrolled_incoming_freshman') return { fit: 'fit_current', relationship: FACT_STATUS.CURRENT }
    return { fit: 'stale', relationship: FACT_STATUS.PAST }
  }
  if (subject.kind === 'place') {
    const place = subject.value
    if (classId === 'birthplace') {
      const bp = timeline?.birthplace
      if (!bp) return { fit: 'unknown', relationship: null }
      const same = (!place.state || !bp.state || place.state === bp.state) &&
        (place.city ? bp.city === place.city : place.county ? bp.county === place.county : true)
      return same ? { fit: 'fit_origin', relationship: FACT_STATUS.ORIGIN } : { fit: 'stale', relationship: null }
    }
    const rel = residenceRelationship(timeline, place)
    if (!rel) {
      // Residency requires living there NOW. A single named COUNTY that every
      // declared current residence provably lies outside is a declared
      // mismatch, like a school the profile says it does not attend. Cities
      // (a city name can be a neighborhood of another), lists and widened
      // areas stay neutral.
      if (requires === REQUIRES.CURRENT && classId === 'residency' && !subject.widened) {
        const outside = currentResidencesOutsideCounty(timeline, place)
        if (outside.length > 0) return { fit: 'elsewhere', relationship: null, elsewhere: outside }
      }
      return { fit: 'unknown', relationship: null }
    }
    if (requires === REQUIRES.PAST_OR_CURRENT) return { fit: rel === FACT_STATUS.PAST ? 'fit_past' : 'fit_current', relationship: rel }
    // residency requires NOW. A past-only tie to a NAMED city/county is stale;
    // a bare state whose current residence differs is the geography gate's
    // call, not this one — stay neutral unless the past tie is the only tie.
    if (rel === FACT_STATUS.CURRENT) return { fit: 'fit_current', relationship: rel }
    return { fit: 'stale', relationship: rel }
  }
  if (subject.kind === 'heritage') {
    return hasHeritage(timeline, subject.value)
      ? { fit: 'fit_origin', relationship: FACT_STATUS.ORIGIN }
      : { fit: 'unknown', relationship: null }
  }
  return { fit: 'unknown', relationship: null }
}

const FIT_RANK = Object.freeze({ fit_current: 3, fit_past: 2, fit_origin: 1, unknown: 0 })

/**
 * The verdict for a row against a timeline.
 * @returns {{ verdict: 'stale'|'elsewhere'|'fit_current'|'fit_past'|'fit_origin'|'unknown', anchors: Array, reason: string|null }|null}
 */
export function temporalAnchorVerdict(timeline, row) {
  const anchors = detectTemporalAnchors(row)
  if (anchors.length === 0) return null
  const judged = anchors.map((a) => ({ ...a, ...judgeAnchor(timeline, a) }))
  const stale = judged.find((a) => a.fit === 'stale') ?? judged.find((a) => a.fit === 'elsewhere')
  if (stale) {
    const cls = TEMPORAL_ANCHOR_CLASSES.find((c) => c.id === stale.classId)
    const was = stale.fit === 'elsewhere'
      ? `elsewhere: the profile declares it ${stale.subject.kind === 'place' ? 'lives in' : 'is at'} ${stale.elsewhere.join(' and ')}`
      : stale.relationship === FACT_STATUS.PAST ? 'a PAST tie' : 'a different declared fact'
    return {
      verdict: stale.fit,
      anchors: judged,
      reason: `Restricted to ${cls?.label ?? stale.classId} (${describeSubject(stale)}: "${stale.phrase}" in ${stale.field}); the profile's relationship is ${was}`,
    }
  }
  let best = 'unknown'
  for (const a of judged) if (FIT_RANK[a.fit] > FIT_RANK[best]) best = a.fit
  const fitAnchor = judged.find((a) => a.fit === best)
  const reason = best === 'unknown'
    ? null
    : `${best === 'fit_current' ? 'Current' : best === 'fit_past' ? 'Past' : 'Origin'} tie honored: ${describeSubject(fitAnchor)} ("${fitAnchor.phrase}")`
  return { verdict: best, anchors: judged, reason }
}

/**
 * Engine entry point: a conflict (provable staleness) or null.
 * Silence — no anchor, or an anchor the profile says nothing about — is null.
 */
export function temporalAnchorConflict(sections, row, { now = new Date() } = {}) {
  const timeline = buildProfileFactTimeline(sections ?? {}, { now })
  const v = temporalAnchorVerdict(timeline, row)
  if (!v || (v.verdict !== 'stale' && v.verdict !== 'elsewhere')) return null
  const stale = v.anchors.find((a) => a.fit === v.verdict)
  return { reason: v.reason, classId: stale.classId, phrase: stale.phrase, field: stale.field, subject: describeSubject(stale) }
}

/**
 * Explain payload for a non-conflicting row: what the row anchors to and how
 * the profile relates. `null` when the row declares nothing temporal.
 */
export function temporalAnchorEvidence(sections, row, { now = new Date() } = {}) {
  const timeline = buildProfileFactTimeline(sections ?? {}, { now })
  const v = temporalAnchorVerdict(timeline, row)
  if (!v) return null
  return {
    verdict: v.verdict,
    reason: v.reason,
    anchors: v.anchors.map((a) => ({ class: a.classId, subject: describeSubject(a), phrase: a.phrase, field: a.field, fit: a.fit })),
  }
}

/** Search seeds for what the profile qualifies for BY HISTORY OR ORIGIN. */
export function originSearchTerms(sections, { now = new Date(), limit = 6 } = {}) {
  const t = buildProfileFactTimeline(sections ?? {}, { now })
  const terms = []
  for (const inst of t.institutions.filter((i) => i.status === FACT_STATUS.PAST)) terms.push(`${inst.name} alumni scholarship`)
  for (const h of t.heritage) terms.push(`${h.value} heritage scholarship`)
  if (t.birthplace?.city) terms.push(`${t.birthplace.city} native scholarship`)
  for (const r of t.residences.filter((x) => x.status === FACT_STATUS.PAST)) {
    if (r.county) terms.push(`${r.county} county former resident scholarship`)
    else if (r.city) terms.push(`${r.city} ${normalizeStateCode(r.state) ?? ''} hometown scholarship`.replace(/\s+/g, ' ').trim())
  }
  return [...new Set(terms.map((x) => x.toLowerCase()))].slice(0, limit)
}

export default {
  REQUIRES,
  TEMPORAL_ANCHOR_CLASSES,
  detectTemporalAnchors,
  temporalAnchorVerdict,
  temporalAnchorConflict,
  temporalAnchorEvidence,
  originSearchTerms,
}
