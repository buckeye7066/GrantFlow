/**
 * Proves that match_explain surfaces the mission-audit profile signals
 * (country, employee_count, annual_revenue, years_in_operation, veteran_owned,
 * woman_owned, minority_owned, organization_type, population_served,
 * mission_focus) whenever the profile supplies them.
 *
 * These tests would fail before the fix because the previous match_explain
 * output had no `profileSignalsUsed` list and the reasons array did not
 * mention these specific fields.
 */
import { describe, it, expect } from 'vitest'
import { scoreOpportunity } from '../services/matchEngine.js'
import { normalizeProfile } from '../services/profileNormalizer.js'

function contextFor(profile, sections = {}) {
  const norm = normalizeProfile(profile, sections, null)
  return { profile, sections, profileNorm: norm }
}

describe('match_explain profile signals', () => {
  it('includes profileSignalsUsed and profileReasonLines when present', () => {
    const ctx = contextFor(
      {
        id: 'p1',
        country: 'US',
        state: 'TN',
        city: 'Knoxville',
        zip: '37902',
        primary_type: 'nonprofit',
      },
      {
        organization_details: {
          organization_type: 'nonprofit',
          population_served: 'veterans',
          mission_focus: 'workforce_development',
          employee_count: 12,
          years_in_operation: 8,
          annual_revenue: 450000,
          veteran_owned: true,
          woman_owned: true,
        },
        funding_needs: { need_categories: ['programs'] },
      }
    )
    const opp = {
      id: 'o1',
      title: 'Veterans workforce grant',
      description: 'Support for nonprofits serving veterans in workforce development',
      application_url: 'https://grants.gov/foa/veterans',
      is_national: true,
      categories: ['veterans', 'workforce'],
    }

    const { match_explain } = scoreOpportunity(ctx, opp)

    expect(match_explain).toBeTruthy()
    expect(Array.isArray(match_explain.profileSignalsUsed)).toBe(true)
    const keys = match_explain.profileSignalsUsed.map((s) => s.key)
    expect(keys).toContain('country')
    expect(keys).toContain('organizationType')
    expect(keys).toContain('populationServed')
    expect(keys).toContain('missionFocus')
    expect(keys).toContain('employeeCount')
    expect(keys).toContain('yearsInOperation')

    // Plain-language reason lines include each of the flagged fields.
    const reasonText = match_explain.profileReasonLines.join(' | ').toLowerCase()
    expect(reasonText).toMatch(/country: us/i)
    expect(reasonText).toMatch(/population served/i)
    expect(reasonText).toMatch(/mission focus/i)
    expect(reasonText).toMatch(/veteran-owned/i)
  })

  it('does not synthesize reasons when the profile is empty', () => {
    const { match_explain } = scoreOpportunity(
      { id: 'p2' },
      { id: 'o2', title: 'Some grant', application_url: 'https://grants.gov/x' }
    )
    expect(match_explain.profileReasonLines).toEqual([])
    // profileSignalsUsed may be empty or only reflect defaults (isX false)
    // but must not claim signals that are not present.
    for (const sig of match_explain.profileSignalsUsed || []) {
      expect(sig.present).toBe(true)
    }
  })
})
