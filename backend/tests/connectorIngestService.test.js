/**
 * The connector ingest is only as relatable as its profile→query mapping.
 * These tests pin the mapping behavior that drives which slice of each external
 * source a profile actually pulls — the relatability lever, exercised without
 * any DB or network.
 */
import { describe, it, expect } from 'vitest'
import {
  buildConnectorQueryPlan,
  collectNeedTerms,
  PROFILE_QUERY_MAP,
} from '../services/connectorIngestService.js'

describe('collectNeedTerms', () => {
  it('pulls explicit profile needs, deduped and lowercased', () => {
    const terms = collectNeedTerms({ profile: { needs: ['Housing', 'housing', 'Food Security'] } })
    expect(terms).toEqual(['housing', 'food security'])
  })

  it('folds in signal Sets without throwing on missing sections', () => {
    const terms = collectNeedTerms(
      { profile: {} },
      { keywords: new Set(['veteran', 'disability']), assistance: ['utilities'] },
    )
    expect(terms).toContain('veteran')
    expect(terms).toContain('utilities')
  })

  it('drops too-short and too-long tokens', () => {
    const terms = collectNeedTerms({ profile: { needs: ['ab', 'x'.repeat(80), 'childcare'] } })
    expect(terms).toEqual(['childcare'])
  })

  it('mines ALL discriminating signal facets, not just keywords/assistance/geographic', () => {
    const terms = collectNeedTerms(
      { profile: {} },
      {
        health: new Set(['kidney disease']),
        military: new Set(['veteran']),
        occupation: new Set(['nurse']),
        family: new Set(['single parent']),
        demographics: new Set(['native american']),
        immigration: new Set(['refugee']),
      },
    )
    // Each facet maps to a distinct funder pool — every one must reach the query.
    for (const t of ['kidney disease', 'veteran', 'nurse', 'single parent', 'native american', 'refugee']) {
      expect(terms).toContain(t)
    }
  })

  it('interleaves facets so one facet cannot crowd the others out of a maxTerms slice', () => {
    const terms = collectNeedTerms(
      { profile: {} },
      {
        // Six keyword variants would, under naive concatenation, fill the first
        // slots and bury the single high-signal veteran/disability terms.
        keywords: new Set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']),
        military: new Set(['veteran']),
        health: new Set(['dialysis']),
      },
    )
    const top4 = terms.slice(0, 4)
    expect(top4).toContain('veteran')
    expect(top4).toContain('dialysis')
  })

  it('explicit profile needs lead ahead of derived signal terms', () => {
    const terms = collectNeedTerms(
      { profile: { needs: ['rental assistance'] } },
      { keywords: new Set(['budgeting']) },
    )
    expect(terms[0]).toBe('rental assistance')
  })

  it('strips content-free generic single tokens that make useless queries', () => {
    const terms = collectNeedTerms(
      { profile: {} },
      { keywords: new Set(['assistance', 'help', 'funding', 'veteran housing']) },
    )
    expect(terms).not.toContain('assistance')
    expect(terms).not.toContain('help')
    expect(terms).not.toContain('funding')
    expect(terms).toContain('veteran housing') // multi-word phrases are always kept
  })
})

describe('buildConnectorQueryPlan', () => {
  it('maps an individual to individual eligibility and a foundation seeker', () => {
    const plan = buildConnectorQueryPlan({ profile: { primary_type: 'individual', state: 'TN', needs: ['food'] } })
    expect(plan.ggEligibility).toContain('21') // Grants.gov: Individuals
    expect(plan.foundationSeeker).toBe(true)
    expect(plan.wantsResearch).toBe(false) // never flood an individual with NIH research awards
    expect(plan.federalApplicant).toBe(false) // individuals don't apply to agency NOFOs
    expect(plan.state).toBe('TN')
    expect(plan.terms).toContain('food')
  })

  it('maps a nonprofit to 501c3 eligibility across Grants.gov and Simpler', () => {
    const plan = buildConnectorQueryPlan({ profile: { primary_type: 'nonprofit' } })
    expect(plan.ggEligibility).toContain('12') // 501c3 nonprofits
    // Official Simpler Grants applicant_type enum (corrected in 710e0721); the
    // bare `nonprofits_501c3` value never existed in the canonical enum.
    expect(plan.simplerApplicant).toContain('nonprofits_non_higher_education_with_501c3')
    expect(plan.wantsResearch).toBe(true)
    expect(plan.federalApplicant).toBe(true) // orgs apply to federal NOFOs
  })

  it('treats unknown profile types as federal applicants (cast wide)', () => {
    expect(buildConnectorQueryPlan({ profile: { primary_type: 'wizard' } }).federalApplicant).toBe(true)
    expect(buildConnectorQueryPlan({ profile: { primary_type: 'student' } }).federalApplicant).toBe(false)
  })

  it('maps a volunteer fire department to special-district + nonprofit eligibility', () => {
    const plan = buildConnectorQueryPlan({ profile: { primary_type: 'volunteer_fire_department' } })
    expect(plan.ggEligibility).toEqual(expect.arrayContaining(['04', '12']))
    expect(plan.simplerApplicant).toContain('special_district_governments')
  })

  it('falls back to an unrestricted-but-bounded plan for unknown types', () => {
    const plan = buildConnectorQueryPlan({ profile: { primary_type: 'wizard' } })
    expect(plan.primaryType).toBe('wizard')
    expect(plan.ggEligibility).toContain('99') // Unrestricted
    expect(plan.simplerApplicant).toEqual([])
  })

  it('every mapped profile type carries the four required plan keys', () => {
    for (const [type, plan] of Object.entries(PROFILE_QUERY_MAP)) {
      expect(Array.isArray(plan.ggEligibility), `${type}.ggEligibility`).toBe(true)
      expect(plan.ggEligibility.length, `${type} has >=1 eligibility code`).toBeGreaterThan(0)
      expect(Array.isArray(plan.simplerApplicant), `${type}.simplerApplicant`).toBe(true)
      expect(typeof plan.foundationSeeker, `${type}.foundationSeeker`).toBe('boolean')
      expect(typeof plan.wantsResearch, `${type}.wantsResearch`).toBe('boolean')
    }
  })
})
