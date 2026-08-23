/**
 * Vetted national assistance funder slice + its display rule (owner rule
 * 2026-08-23: need-based profiles must reach the funds that PAY, not only
 * directories). Built on the real prod row/profile shapes.
 */
import { describe, it, expect } from 'vitest'
import {
  assistanceFunderNeeds,
  isVettedNationalAssistanceFunder,
  profileAssistanceNeeds,
  funderServesDeclaredNeed,
  assistanceFunderSqlSuperset,
} from '../config/nationalAssistanceFunders.js'
import { qualifiesForDisplay } from '../config/matchSurfacing.js'

const funder = (o) => ({ is_national: true, opportunity_kind: 'DIRECT_GRANT', ...o })

describe('assistanceFunderNeeds — the vetted slice', () => {
  it('recognizes a national awardable vetted funder and returns its served needs', () => {
    expect(assistanceFunderNeeds(funder({ sponsor: 'HealthWell Foundation', title: 'Copay Assistance' }))).toEqual(['medical'])
    expect(assistanceFunderNeeds(funder({ sponsor: 'Modest Needs Foundation', title: 'Self-Sufficiency Grant' }))).toEqual(['basic_needs'])
    expect(assistanceFunderNeeds(funder({ sponsor: 'PAN Foundation', title: 'Patient Access Network' }))).toEqual(['medical'])
  })
  it('a DIRECTORY row is never in the slice (a pointer is not an award)', () => {
    expect(assistanceFunderNeeds(funder({ sponsor: 'NeedyMeds', title: 'NeedyMeds', opportunity_kind: 'directory' }))).toBeNull()
  })
  it('a NON-national row is not in the slice (this slice is the national players)', () => {
    expect(assistanceFunderNeeds(funder({ sponsor: 'HealthWell Foundation', is_national: false }))).toBeNull()
  })
  it('a row that is not a vetted identity is not in the slice (no title-substring flood)', () => {
    // real prod junk the broad "assistance" LIKE would have caught:
    expect(assistanceFunderNeeds(funder({ sponsor: 'SASSA', title: 'Disability Grant' }))).toBeNull()
    expect(assistanceFunderNeeds(funder({ sponsor: "El Paso Children's Hospital", title: 'Director of Outpatient Clinical Services' }))).toBeNull()
    expect(assistanceFunderNeeds(funder({ sponsor: 'Some County', title: 'Emergency Assistance Program' }))).toBeNull()
  })
  it('isVettedNationalAssistanceFunder is the boolean form', () => {
    expect(isVettedNationalAssistanceFunder(funder({ sponsor: 'CancerCare', title: 'Co-Payment Assistance' }))).toBe(true)
    expect(isVettedNationalAssistanceFunder(funder({ sponsor: 'Random LLC', title: 'Grant' }))).toBe(false)
  })
})

describe('profileAssistanceNeeds — declared, structured, never prose', () => {
  it('a disabled adult declares disability + medical', () => {
    const n = profileAssistanceNeeds({ primary_type: 'disabled_adult' }, {})
    expect(n.has('disability')).toBe(true)
    expect(n.has('medical')).toBe(true)
  })
  it('a senior declares senior; age >= 60 also does', () => {
    expect(profileAssistanceNeeds({ primary_type: 'senior' }, {}).has('senior')).toBe(true)
    expect(profileAssistanceNeeds({ primary_type: 'individual' }, { demographics: { age: 71 } }).has('senior')).toBe(true)
  })
  it('a declared disability_status (not a denial) yields disability+medical; a denial does NOT', () => {
    expect(profileAssistanceNeeds({ primary_type: 'individual' }, { demographics: { disability_status: 'Has disability' } }).has('disability')).toBe(true)
    const denied = profileAssistanceNeeds({ primary_type: 'individual' }, { demographics: { disability_status: 'No disability' } })
    expect(denied.has('disability')).toBe(false)
  })
  it('declared structured needs map to families', () => {
    const n = profileAssistanceNeeds({ primary_type: 'family', needs: ['housing', 'food'] }, {})
    expect(n.has('basic_needs')).toBe(true)
    const m = profileAssistanceNeeds({ primary_type: 'individual' }, { health_medical: { needs: ['prescription'] } })
    expect(m.has('medical')).toBe(true)
  })
  it('an ORG never qualifies for individual assistance funds', () => {
    expect(profileAssistanceNeeds({ primary_type: 'nonprofit', needs: ['medical'] }, {}).size).toBe(0)
    expect(profileAssistanceNeeds({ primary_type: 'small_business_ORG', needs: ['housing'] }, {}).size).toBe(0)
  })
  it('MISSING = NEUTRAL: a profile declaring nothing gets an empty set', () => {
    expect(profileAssistanceNeeds({ primary_type: 'individual' }, {}).size).toBe(0)
  })
  it('a NULL-type profile with an org signal is an organization → empty (the test-org slip)', () => {
    const n = profileAssistanceNeeds(
      { primary_type: null, needs: ['medical'] },
      { organization_details: { organization_type: 'nonprofit' } },
    )
    expect(n.size).toBe(0)
  })
  it('a real individual with a stray org_details section is NOT excluded (its type wins)', () => {
    const n = profileAssistanceNeeds(
      { primary_type: 'individual', needs: ['medical'] },
      { organization_details: { organization_type: 'nonprofit' } },
    )
    expect(n.has('medical')).toBe(true)
  })
})

describe('funderServesDeclaredNeed — the recall net gate', () => {
  it('links when the funder need overlaps a declared need', () => {
    const declared = profileAssistanceNeeds({ primary_type: 'disabled_adult' }, {})
    expect(funderServesDeclaredNeed(funder({ sponsor: 'HealthWell Foundation' }), declared)).toBe(true)
  })
  it('does NOT link when there is no overlap, or when declared is empty', () => {
    const seniorOnly = new Set(['senior'])
    expect(funderServesDeclaredNeed(funder({ sponsor: 'HealthWell Foundation' }), seniorOnly)).toBe(false) // medical vs senior
    expect(funderServesDeclaredNeed(funder({ sponsor: 'Modest Needs' }), new Set())).toBe(false)
  })
})

describe('qualifiesForDisplay — the vetted slice surfaces below the numeric floor', () => {
  const HIGH_FLOOR = 40
  it('a vetted funder at REVIEW below the floor SURFACES (recommendable at REVIEW)', () => {
    const row = funder({ sponsor: 'PAN Foundation', match_decision: 'review', match_score: 8 })
    expect(qualifiesForDisplay(row, HIGH_FLOOR)).toBe(true)
  })
  it('a NON-vetted awardable at REVIEW below the floor stays HIDDEN (no bar lowered globally)', () => {
    const row = funder({ sponsor: 'Random Research Institute', title: 'R01 Grant', match_decision: 'review', match_score: 8 })
    expect(qualifiesForDisplay(row, HIGH_FLOOR)).toBe(false)
  })
  it('a REJECT vetted funder NEVER surfaces', () => {
    const row = funder({ sponsor: 'HealthWell Foundation', match_decision: 'reject', match_score: 8 })
    expect(qualifiesForDisplay(row, HIGH_FLOOR)).toBe(false)
  })
  it('an inactive/hidden vetted funder never surfaces', () => {
    expect(qualifiesForDisplay(funder({ sponsor: 'HealthWell Foundation', match_decision: 'review', match_score: 8, is_active: false }), 1)).toBe(false)
  })
})

describe('assistanceFunderSqlSuperset', () => {
  it('builds a LIKE superset with 2 params per pattern and rejects a bad alias', () => {
    const s = assistanceFunderSqlSuperset('fo')
    expect(s.clause).toMatch(/LOWER\(COALESCE\(fo\.sponsor/)
    expect(s.params.length % 2).toBe(0)
    expect(s.params.every((p) => p.startsWith('%') && p.endsWith('%'))).toBe(true)
    expect(() => assistanceFunderSqlSuperset('fo; DROP')).toThrow()
  })
})
