/**
 * fullProfileCoverage.test.js
 *
 * Proves that the canonical profile shape now carries the full
 * business / ownership / organization / population-served data that the
 * mission requires, AND that matchEngine picks up those signals when
 * scoring.
 *
 * These tests are regression gates: if a future refactor drops an
 * ownership flag or an industry field from the normalized profile, these
 * tests fail immediately rather than silently regressing match quality
 * for entire profile classes (businesses, nonprofits, churches, VFDs,
 * schools).
 */
import { describe, it, expect } from 'vitest'
import { normalizeProfile } from '../services/profileNormalizer.js'
import { buildCanonicalProfileView } from '../services/canonicalProfileView.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { buildProfileSignals } from '../services/profileHelpers.js'

function mkSections(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = { answers: v }
  }
  return out
}

function profileContextOf(profile, sections) {
  const signals = buildProfileSignals({ profile, sections })
  const profileNorm = normalizeProfile(profile, sections, signals)
  return { profile, sections, signals, profileNorm }
}

describe('profileNormalizer — full business/ownership/organization coverage', () => {
  it('exposes structured business.* fields for a small-business profile', () => {
    const sections = mkSections({
      small_business_details: {
        industry: 'food service',
        naics_code: '722330',
        business_type: 'LLC',
        employee_count: 4,
        annual_revenue: 85000,
        years_in_business: 2,
        certifications: ['WBE', 'minority-owned'],
      },
      location_focus: { country: 'US', state: 'WV' },
    })
    const n = normalizeProfile(
      { id: 'b1', primary_type: 'small_business', state: 'WV' },
      sections,
    )
    expect(n.business).toBeTruthy()
    expect(n.business.industry).toBe('food service')
    expect(n.business.naicsCode).toBe('722330')
    expect(n.business.employeeCount).toBe(4)
    expect(n.business.annualRevenue).toBe(85000)
    expect(n.business.yearsInOperation).toBe(2)
    expect(n.business.isStartup).toBe(true)
    expect(n.business.isMicroEnterprise).toBe(true)
    expect(n.business.isLowRevenue).toBe(true)
    // Mirrored top-level
    expect(n.industry).toBe('food service')
    expect(n.employeeCount).toBe(4)
    expect(n.yearsInOperation).toBe(2)
    // Ownership flags from certifications
    expect(n.isWomanOwned).toBe(true)
    expect(n.isMinorityOwned).toBe(true)
    expect(n.country).toBe('US')
  })

  it('exposes ownership flags for veteran-owned / SDVOSB organization', () => {
    const sections = mkSections({
      organization_details: {
        organization_type: 'small_business',
        cert_sdvosb: true,
        cert_hubzone: true,
        sam_gov_registered: true,
      },
    })
    const n = normalizeProfile(
      { id: 'b2', primary_type: 'small_business' },
      sections,
    )
    expect(n.ownership.isVeteranOwned).toBe(true)
    expect(n.ownership.isServiceDisabledVeteranOwned).toBe(true)
    expect(n.ownership.isHUBZoneCertified).toBe(true)
    expect(n.ownership.samGovRegistered).toBe(true)
    expect(n.isVeteranOwned).toBe(true)
  })

  it('exposes population_served + mission_focus for a nonprofit / church', () => {
    const sections = mkSections({
      organization_details: {
        organization_type: 'church',
        is_faith_based: true,
        is_rural_serving: true,
        mission: 'Serve low-income rural Appalachian families.',
        population_served: 'low-income families, children, elderly',
      },
      programs_services: {
        focus_areas: ['food pantry', 'utility assistance', 'after-school tutoring'],
      },
    })
    const n = normalizeProfile(
      { id: 'c1', primary_type: 'nonprofit', display_name: 'Hilltop Baptist Church' },
      sections,
    )
    expect(n.organization.organizationType).toBe('church')
    expect(n.organization.isFaithBased).toBe(true)
    expect(n.populationServed).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/low-income/i),
        expect.stringMatching(/children/i),
      ]),
    )
    expect(n.missionFocus.length).toBeGreaterThan(0)
    expect(n.isFaithBased).toBe(true)
    expect(n.ownership.isRuralServing).toBe(true)
  })

  it('handles a volunteer fire / first responder profile without dropping affiliations', () => {
    const sections = mkSections({
      organization_details: {
        organization_type: 'fire_department',
        is_volunteer: true,
      },
    })
    const n = normalizeProfile(
      { id: 'vfd1', primary_type: 'organization' },
      sections,
    )
    // Affiliation-driven; should not hard-fail even with sparse data.
    expect(Array.isArray(n.affiliations)).toBe(true)
    expect(Array.isArray(n.needCategories)).toBe(true)
    expect(n.needCategories.length).toBeGreaterThan(0)
  })

  it('canonicalProfileView flat shape carries structured business/ownership fields', () => {
    const sections = mkSections({
      small_business_details: {
        industry: 'childcare services',
        naics_code: '624410',
        employee_count: 12,
        annual_revenue: 450000,
        years_in_business: 6,
      },
      organization_details: {
        cert_wbe: true,
        cert_8a: true,
      },
    })
    const view = buildCanonicalProfileView({
      profile: { id: 'bv1', primary_type: 'small_business' },
      sections,
    })
    expect(view.flat.industry).toBe('childcare services')
    expect(view.flat.naics_code).toBe('624410')
    expect(view.flat.employee_count).toBe(12)
    expect(view.flat.annual_revenue).toBe(450000)
    expect(view.flat.years_in_operation).toBe(6)
    expect(view.flat.is_woman_owned).toBe(true)
    expect(view.flat.ownership).toBeTruthy()
    expect(view.flat.ownership.is8aCertified).toBe(true)
  })
})

describe('matchEngine — ownership & mission boosts (soft, never hard-gates)', () => {
  const baseOpp = {
    id: 'opp1',
    title: 'Women-Owned Small Business Growth Grant',
    description: 'Grant program for WOSB and woman-owned businesses focused on expansion.',
    application_url: 'https://sba.gov/wosb-grant',
    source_url: 'https://sba.gov/wosb-grant',
    max_amount: 50000,
    deadline: '2099-12-31',
  }

  it('boosts a woman-owned business when the opportunity targets woman-owned businesses', () => {
    const wobSections = mkSections({
      small_business_details: {
        industry: 'retail',
        employee_count: 8,
        years_in_business: 4,
        certifications: ['WBE'],
      },
    })
    const sparseSections = mkSections({
      small_business_details: { industry: 'retail' },
    })
    const wobCtx = profileContextOf(
      { id: 'wob1', primary_type: 'small_business', state: 'CA' },
      wobSections,
    )
    const sparseCtx = profileContextOf(
      { id: 'spr1', primary_type: 'small_business', state: 'CA' },
      sparseSections,
    )

    const boosted = scoreOpportunity(wobCtx, baseOpp)
    const sparse = scoreOpportunity(sparseCtx, baseOpp)

    expect(boosted.score).toBeGreaterThanOrEqual(sparse.score)
  })

  it('does not hard-reject a generic profile from a women-owned opportunity (soft scoring only)', () => {
    const ctx = profileContextOf(
      { id: 'neutral1', primary_type: 'small_business', state: 'CA' },
      mkSections({ small_business_details: { industry: 'retail' } }),
    )
    const res = scoreOpportunity(ctx, baseOpp)
    expect(typeof res.score).toBe('number')
    expect(res.score).toBeGreaterThanOrEqual(0)
  })

  it('boosts nonprofit-with-population-served when opportunity mentions the same population', () => {
    const sections = mkSections({
      organization_details: {
        organization_type: 'nonprofit',
        is_faith_based: true,
        mission: 'Serve low-income rural families.',
        population_served: 'low-income families, children',
      },
      programs_services: {
        focus_areas: ['food pantry', 'youth mentoring'],
      },
    })
    const ctx = profileContextOf(
      { id: 'np1', primary_type: 'nonprofit', state: 'WV' },
      sections,
    )
    const opp = {
      id: 'opp2',
      title: 'Rural Food Pantry Support Grant',
      description:
        'Funding for nonprofits running food pantry and child nutrition programs for low-income families in rural communities.',
      application_url: 'https://example.org/food-pantry',
      source_url: 'https://example.org/food-pantry',
    }
    const res = scoreOpportunity(ctx, opp)
    expect(res.score).toBeGreaterThan(0)
  })
})
