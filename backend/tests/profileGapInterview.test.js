/**
 * profileGapInterview — the backend for Anya's opening interview + the login gap
 * gate + gap-explanation email.
 */
import { describe, it, expect } from 'vitest'
import { buildProfileGapPlan, FACET_QUESTIONS } from '../services/profileGapInterview.js'
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
    expect(byId.has_disability.writes).toMatchObject({ section: 'demographics', field: 'disability_status' })
    expect(byId.is_student.writes).toMatchObject({ section: 'education', field: 'is_student' })
    expect(byId.is_caregiver.writes).toMatchObject({ section: 'family_life', field: 'caregiver' })
  })

  it('does NOT re-ask a facet question the data already answers', () => {
    const n = normalizeProfile(
      { id: 'avanell', primary_type: 'family', state: 'TN', city: 'Cleveland' },
      { demographics: { disability_status: 'Has disability', age_group: 'Senior 62+' }, family_life: { caregiver: true } },
    )
    const plan = buildProfileGapPlan(n, {
      demographics: { disability_status: 'Has disability', age_group: 'Senior 62+' },
      family_life: { caregiver: true },
    }, { displayName: 'Avanell' })
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
    // Give demographics/veteran an explicit answer so no facet question remains.
    const secWithVet = { ...sections, demographics: { ...sections.demographics, veteran_status: false } }
    const plan = buildProfileGapPlan(n, secWithVet, { minCoverage: 0.3 })
    expect(plan.complete).toBe(true)
    expect(plan.email).toBeNull()
  })
})
