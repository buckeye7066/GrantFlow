import { describe, it, expect } from 'vitest'
import {
  computeProfileCoverage,
  listPresentProfileSignals,
  PROFILE_COVERAGE_FIELDS,
} from '../services/profileCoverage.js'

describe('profileCoverage', () => {
  it('returns 0 coverage for an empty profile and surfaces every field as missing', () => {
    const result = computeProfileCoverage({})
    expect(result.coverage).toBe(0)
    expect(result.completeness).toBe('minimal')
    expect(result.fieldSignals.length).toBe(PROFILE_COVERAGE_FIELDS.length)
    expect(result.fieldSignals.every((f) => f.present === false)).toBe(true)
    expect(result.missingFields.length).toBe(PROFILE_COVERAGE_FIELDS.length)
    expect(result.suggestions.length).toBeGreaterThan(0)
  })

  it('credits structured business / ownership / organization fields', () => {
    const normalized = {
      country: 'US',
      state: 'TN',
      city: 'Knoxville',
      zip: '37902',
      entityType: 'business',
      organizationType: 'small_business',
      populationServed: 'veterans',
      missionFocus: 'workforce_development',
      employeeCount: 7,
      annualRevenue: 150000,
      yearsInOperation: 4,
      industry: 'construction',
      isVeteranOwned: true,
      isWomanOwned: false,
      isMinorityOwned: false,
      needCategories: ['equipment', 'operating'],
      fundingAmountNeeded: 50000,
    }
    const r = computeProfileCoverage(normalized)
    expect(r.coverage).toBeGreaterThan(0.7)
    expect(r.completeness === 'strong' || r.completeness === 'complete').toBe(true)
    const covered = new Set(r.covered)
    // All mission-audit fields must be observable as present
    for (const key of [
      'country', 'state', 'organizationType', 'populationServed',
      'missionFocus', 'employeeCount', 'annualRevenue', 'yearsInOperation',
      'isVeteranOwned', 'needCategories',
    ]) {
      expect(covered.has(key)).toBe(true)
    }
  })

  it('detects missing canonical sections when rawSections omits them', () => {
    const r = computeProfileCoverage(
      { state: 'CA' },
      { location_focus: { data: { state: 'CA' } } }
    )
    expect(r.missingSections).toContain('basic_information')
    expect(r.missingSections).toContain('funding_needs')
    expect(r.missingSections).toContain('financial_information')
  })

  it('listPresentProfileSignals returns only filled fields', () => {
    const signals = listPresentProfileSignals({
      country: 'US',
      organizationType: 'nonprofit',
      populationServed: 'youth',
      isMinorityOwned: false, // explicit false is still "covered"
    })
    const keys = signals.map((s) => s.key)
    expect(keys).toContain('country')
    expect(keys).toContain('organizationType')
    expect(keys).toContain('populationServed')
    expect(keys).toContain('isMinorityOwned')
    expect(keys).not.toContain('industry')
  })
})
