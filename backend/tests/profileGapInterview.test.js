/**
 * profileGapInterview — the backend for Anya's opening interview + the login gap
 * gate + gap-explanation email.
 */
import { describe, it, expect } from 'vitest'
import { buildProfileGapPlan, FACET_QUESTIONS, GAP_QUESTIONS } from '../services/profileGapInterview.js'
import { guardProfileSectionPayload } from '../utils/profileSuggestionGuards.js'
import { deriveProfileFieldMirrors, mirrorTargets } from '../../shared/profileFieldMirrors.js'

import { normalizeProfile } from '../services/profileNormalizer.js'

describe('buildProfileGapPlan', () => {
  it('flags an essentially-empty profile (Kathy) as incomplete and asks the facet + gap questions', () => {
    const n = normalizeProfile({ id: 'kathy', primary_type: 'individual' }, {})
    const plan = buildProfileGapPlan(n, {}, { displayName: 'Kathy' })
    expect(plan.complete).toBe(false)
    expect(plan.needs_questions).toBe(true)
    // All dichotomous facet questions are unanswered for a blank profile.
    const ids = plan.questions.map((q) => q.id)
    expect(ids).toEqual(expect.arrayContaining(['has_disability', 'is_senior', 'is_student']))
    // A gap-explanation email is produced.
    expect(plan.email).toBeTruthy()
    expect(plan.email.subject).toMatch(/questions/i)
    expect(plan.email.body).toMatch(/Annie/)
    expect(plan.email.body).toMatch(/Hello Kathy,/)
  })

  it('each facet question maps its answer to the section/field that drives the derived facet', () => {
    const byId = Object.fromEntries(FACET_QUESTIONS.map((q) => [q.id, q]))
    expect(byId.has_disability.writes).toMatchObject({ section: 'health_medical', field: 'has_disability' })
    expect(byId.is_veteran.writes).toMatchObject({ section: 'military_service', field: 'veteran' })
    expect(byId.is_student.writes).toMatchObject({ section: 'education', field: 'is_student' })
    expect(byId.is_caregiver.writes).toMatchObject({ section: 'family_life', field: 'caregiver' })
  })

  it('does NOT re-ask a facet question the data already answers', () => {
    const n = normalizeProfile(
      { id: 'demo_senior_applicant', primary_type: 'family', state: 'TN', city: 'Cleveland' },
      { demographics: { disability_status: 'Has disability', age_group: 'Senior 62+' }, family_life: { caregiver: true } },
    )
    const plan = buildProfileGapPlan(n, {
      demographics: { disability_status: 'Has disability', age_group: 'Senior 62+' },
      family_life: { caregiver: true },
    }, { displayName: 'demo_senior_applicant' })
    const ids = plan.questions.map((q) => q.id)
    // disability / senior / caregiver are already known — don't ask again.
    expect(ids).not.toContain('has_disability')
    expect(ids).not.toContain('is_senior')
    expect(ids).not.toContain('is_caregiver')
  })

  it('a well-filled profile needs no questions and gets no gap email', () => {
    const sections = {
      location_focus: { state: 'TN', city: 'Cleveland', zip_code: '37312' },
      demographics: { disability_status: 'Has disability', age_group: 'Senior 62+' },
      education: { is_student: false },
      family_life: { caregiver: true },
      funding_needs: { need_categories: ['housing', 'medical'] },
      financial_information: { funding_amount_needed: 5000 },
      basic_information: { applicant_kind: 'individual' },
    }
    const n = normalizeProfile(
      { id: 'full', primary_type: 'individual', state: 'TN', city: 'Cleveland', zip: '37312' },
      sections,
    )
    // Give the veteran facet an explicit answer so no facet question remains.
    // It goes to the CANONICAL military_service.veteran — the old fixture put a
    // boolean into demographics.veteran_status, a deprecated STRING field the
    // mirrors overwrite, which is the very bug this suite now pins.
    const secWithVet = { ...sections, military_service: { veteran: false } }
    const plan = buildProfileGapPlan(n, secWithVet, { minCoverage: 0.3 })
    expect(plan.complete).toBe(true)
    expect(plan.email).toBeNull()
  })
})

// Every interview answer must SURVIVE the section-write guard. The section PUT
// (backend/routes/profiles.js) runs guardProfileSectionPayload before writing;
// a `writes` target the guard does not know is dropped as unknown_field with a
// 200 OK — the answer silently vanishes and the question is re-asked at every
// login (GeneMac, 2026-09-07: education.is_student written as {} in prod).
describe('interview writes survive guardProfileSectionPayload', () => {
  const profile = { id: 'p', primary_type: 'individual' }
  const cases = []
  for (const q of FACET_QUESTIONS) {
    cases.push({ label: `${q.id}=yes`, ...q.writes, value: q.writes.yes })
    cases.push({ label: `${q.id}=no`, ...q.writes, value: q.writes.no })
  }
  for (const q of Object.values(GAP_QUESTIONS)) {
    cases.push({ label: q.id, ...q.writes, value: q.type === 'number' ? 5000 : 'sample answer' })
  }

  it.each(cases)('$label survives the section guard', ({ section, field, value }) => {
    const guarded = guardProfileSectionPayload({ [field]: value }, { profile, sections: {}, sectionKey: section })
    const dropped = guarded.rejected.filter((r) => !r.routedTo)
    expect(dropped).toEqual([])
    const persistedKey = guarded.rejected.find((r) => r.routedTo)?.routedTo ?? field
    expect(Object.prototype.hasOwnProperty.call(guarded.data, persistedKey)).toBe(true)
  })
})


/**
 * THE INVARIANT THAT MATTERS: an answer the user gives must still read back as
 * ANSWERED after the complete save path runs, so the question is never asked
 * again.
 *
 * The 2026-09-07 version of this suite stopped at the section guard, so it
 * stayed green while two questions were still unanswerable in production:
 *   - is_veteran wrote demographics.veteran_status, the DEPRECATED half of a
 *     mirror pair; the very next mirror pass re-derived that field from
 *     military_service.veteran and blanked the answer to ''.
 *   - has_disability wrote demographics.disability_status and was blanked the
 *     same way whenever the health_medical per-type flags were stored false.
 * In both cases the PUT answered 200 with an empty `rejected`, so nothing could
 * tell that the answer had evaporated — the user was asked the same question at
 * every single login (Anastasia White, 2026-09-08).
 *
 * So this walks the WHOLE path — section guard -> field mirrors -> the real
 * buildProfileGapPlan entry point — against profile shapes that really occur,
 * and fails if any answer stops reading back. A future question pointed at an
 * erasable field cannot pass.
 */
describe('every interview answer survives the whole save path and is not re-asked', () => {
  const FIXTURES = {
    'blank person': { basic_information: { full_name: 'T', applicant_kind: 'individual' } },
    'date of birth known': {
      basic_information: { full_name: 'T', applicant_kind: 'individual', date_of_birth: '2008-07-19' },
    },
    // The shape that broke production: an earlier pass stored an explicit
    // `false` for every military + health flag, which is what drove the mirrors
    // to blank the interview's answer.
    'explicit false flags already stored': {
      basic_information: { full_name: 'T', applicant_kind: 'individual' },
      military_service: { veteran: false, disabled_veteran: false, active_duty_military: false, national_guard: false },
      health_medical: {
        visual_impairment: false, hearing_impairment: false, wheelchair_user: false,
        tbi_survivor: false, amputee: false, mental_health_condition: false, neurodivergent: false,
      },
      family_life: { caregiver: false },
    },
    organization: {
      basic_information: { full_name: 'Org', applicant_kind: 'organization' },
      narrative: {}, organization_details: {},
    },
  }

  const answersFor = (q) =>
    q.type === 'yes_no'
      ? [['yes', q.writes.yes], ['no', q.writes.no]]
      : [['value', q.type === 'number' ? 5000 : 'sample answer']]

  const cases = []
  for (const [fixture, sections] of Object.entries(FIXTURES)) {
    for (const q of [...FACET_QUESTIONS, ...Object.values(GAP_QUESTIONS)]) {
      for (const [label, value] of answersFor(q)) {
        if (value === null || value === undefined) continue
        cases.push({ label: `${q.id}=${label} on "${fixture}"`, id: q.id, writes: q.writes, value, sections })
      }
    }
  }

  it.each(cases)('$label still reads back as answered', ({ id, writes, value, sections: fixture }) => {
    const sections = structuredClone(fixture)
    const { section, field } = writes

    // 1. the section PUT: merge into the section's current data, then guard it
    const merged = { ...(sections[section] || {}), [field]: value }
    const guarded = guardProfileSectionPayload(merged, {
      profile: { id: 'p' }, sections, sectionKey: section, existing: sections[section] || {},
    })
    expect(guarded.rejected.filter((r) => r.key === field && !r.routedTo)).toEqual([])
    sections[section] = guarded.data

    // 2. the field mirrors (they run over every profile on the boot backfill)
    const { patches } = deriveProfileFieldMirrors(sections)
    for (const [key, patch] of Object.entries(patches)) sections[key] = { ...(sections[key] || {}), ...patch }

    // 3. the real read side: the question must NOT come back
    const normalized = normalizeProfile({ id: 'p' }, sections)
    const plan = buildProfileGapPlan(normalized, sections, { profile: { id: 'p' } })
    expect(plan.questions.map((q) => q.id)).not.toContain(id)
  })

  it('no question writes to a field the mirrors will overwrite', () => {
    // The structural root cause: a `writes` target that is the DEPRECATED half
    // of a mirror pair is re-derived from its canonical source on the next
    // mirror pass, so the answer is erased no matter what the guard says.
    const targets = new Set(mirrorTargets())
    const offenders = [...FACET_QUESTIONS, ...Object.values(GAP_QUESTIONS)]
      .map((q) => ({ id: q.id, key: `${q.writes.section}.${q.writes.field}` }))
      .filter(({ key }) => targets.has(key))
      .map(({ id, key }) => `${id} -> ${key}`)
    expect(offenders).toEqual([])
  })
})
