/**
 * Data-derived effective profile FACETS.
 *
 * The clicked primary_type is advisory; a profile's eligibility must come from
 * its DATA. normalizeProfile derives `effectiveFacets` (a union of facts) so a
 * disabled senior individual is eligible for disability + senior + individual
 * funding regardless of the type they selected — the exact demo_senior_applicant case.
 */
import { describe, it, expect } from 'vitest'
import { normalizeProfile } from '../services/profileNormalizer.js'

describe('effectiveFacets — data over clicked type', () => {
  it('derives disabled + senior + individual + caregiver from demo_senior_applicant-shaped data (clicked "family")', () => {
    const n = normalizeProfile(
      { id: 'demo_senior_applicant', primary_type: 'family', state: 'TN', city: 'Cleveland' },
      {
        demographics: { disability_status: 'Has disability', age_group: 'Senior 62+' },
        family_life: { caregiver: true },
      },
    )
    expect(n.effectiveFacets).toEqual(expect.arrayContaining(['individual', 'senior', 'disabled', 'caregiver']))
    // A family/senior/disabled individual is NOT a student.
    expect(n.effectiveFacets).not.toContain('student')
    expect(n.hasDisabilityNeed).toBe(true)
  })

  it('additively grants the student facet when the data shows a student, even if clicked "individual"', () => {
    const n = normalizeProfile(
      { id: 's1', primary_type: 'individual', state: 'TN', age: 20 },
      { education: { answers: { is_student: true, school_name: 'Cleveland State' } } },
    )
    expect(n.effectiveFacets).toContain('student')
    expect(n.effectiveFacets).toContain('individual')
  })

  it('an organization profile yields org facets, not "individual"', () => {
    const n = normalizeProfile(
      { id: 'church', primary_type: 'church', state: 'OH', organization_name: 'Vermilion COGOP' },
      {},
    )
    expect(n.effectiveFacets).toContain('nonprofit')
    expect(n.effectiveFacets).not.toContain('individual')
  })

  it('an empty profile falls back to the clicked type so it is never left with zero signal', () => {
    const n = normalizeProfile({ id: 'kathy', primary_type: 'individual' }, {})
    expect(Array.isArray(n.effectiveFacets)).toBe(true)
    expect(n.effectiveFacets.length).toBeGreaterThan(0)
    expect(n.effectiveFacets).toContain('individual')
  })

  it('reads a boolean disability_status too', () => {
    const n = normalizeProfile(
      { id: 'd1', primary_type: 'individual' },
      { demographics: { disability_status: true } },
    )
    expect(n.effectiveFacets).toContain('disabled')
  })
})
