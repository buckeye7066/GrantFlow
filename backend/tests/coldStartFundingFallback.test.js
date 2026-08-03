import { describe, expect, it, vi } from 'vitest'

import {
  buildColdStartFundingFallback,
  COLD_START_CATALOG_SQL,
  classifyColdStartProfile,
  coldStartProgramFamily,
  familyAllowedForColdStart,
} from '../services/matching/coldStartFundingFallback.js'

function individualContext(overrides = {}) {
  const profile = {
    id: 'profile-william',
    display_name: 'William',
    primary_type: 'individual',
    state: 'TN',
    needs: ['healthcare', 'food', 'utilities'],
    ...overrides.profile,
  }
  return {
    profile,
    sections: {
      demographics: {},
      contact_information: { state: 'TN' },
      ...overrides.sections,
    },
    signals: {
      location: { state: 'TN' },
      needs: new Set(profile.needs),
      applicantTypes: ['individual'],
      ...overrides.signals,
    },
  }
}

function program({ id, title, category, state = 'TN', national = false, description, ...rest }) {
  return {
    id,
    title,
    sponsor: national ? 'United States Government' : 'Tennessee Human Services',
    description: description || `${title} provides ${category} assistance to eligible residents.`,
    application_url: `https://example.gov/apply/${id}`,
    source_url: `https://example.gov/programs/${id}`,
    state: national ? 'nationwide' : state,
    is_national: national ? 1 : 0,
    opportunity_type: 'benefit',
    opportunity_kind: 'DIRECT_BENEFIT',
    type: 'OPPORTUNITY',
    funding_type: 'direct_benefit',
    categories: JSON.stringify([category]),
    keywords: JSON.stringify([category, title]),
    deadline_type: 'rolling',
    is_active: 1,
    is_hidden: 0,
    record_origin: 'curated_verified',
    source: 'curated_benefits',
    ...rest,
  }
}

describe('cold-start funding fallback', () => {
  it('classifies sparse real individuals without treating organizations as households', () => {
    expect(classifyColdStartProfile(individualContext())).toMatchObject({
      eligible: true,
      individualRoot: true,
      publicAgencyRoot: false,
      states: ['TN'],
      isStudent: false,
      hasDisabilityEvidence: false,
    })

    expect(classifyColdStartProfile({
      profile: { display_name: 'Focus Forward Ministry', primary_type: 'church' },
      sections: { organization_details: { is_nonprofit: true } },
    })).toMatchObject({ eligible: false, reason: 'organization_profile' })

    expect(classifyColdStartProfile({
      profile: { display_name: 'Admin Vault', primary_type: 'individual' },
    })).toMatchObject({ eligible: false })
  })

  it.each([
    ['Tennessee Medicaid / TennCare', 'medicaid'],
    ['SNAP Supplemental Nutrition Assistance Program', 'snap'],
    ['LIHEAP Home Energy Assistance', 'liheap'],
    ['Social Security Disability Insurance (SSDI)', 'ssdi'],
    ['Supplemental Security Income (SSI)', 'ssi'],
    ['Federal Pell Grant', 'pell'],
    ['Federal Work-Study', 'work_study'],
  ])('recognizes the baseline family %s', (title, expected) => {
    expect(coldStartProgramFamily({ title })).toBe(expected)
  })

  it('keeps conditional disability and student families conditional', () => {
    const ordinary = classifyColdStartProfile(individualContext())
    expect(familyAllowedForColdStart('medicaid', ordinary)).toBe(true)
    expect(familyAllowedForColdStart('snap', ordinary)).toBe(true)
    expect(familyAllowedForColdStart('liheap', ordinary)).toBe(true)
    expect(familyAllowedForColdStart('ssdi', ordinary)).toBe(false)
    expect(familyAllowedForColdStart('ssi', ordinary)).toBe(false)
    expect(familyAllowedForColdStart('pell', ordinary)).toBe(false)
    expect(familyAllowedForColdStart('work_study', ordinary)).toBe(false)

    const studentWithDisability = classifyColdStartProfile(individualContext({
      profile: { primary_type: 'student', needs: ['healthcare', 'food', 'utilities', 'education', 'disability'] },
      sections: {
        education: { student_status: true, current_college: 'Cleveland State Community College' },
        health_medical: { has_disability: true, disability_status: 'disabled' },
      },
    }))
    expect(studentWithDisability).toMatchObject({
      eligible: true,
      isStudent: true,
      hasDisabilityEvidence: true,
    })
    for (const family of ['ssdi', 'ssi', 'pell', 'work_study']) {
      expect(familyAllowedForColdStart(family, studentWithDisability)).toBe(true)
    }
  })

  it('filters inactive and hidden rows in SQL before the candidate limit', () => {
    const sql = String(COLD_START_CATALOG_SQL)
    expect(sql).toMatch(/COALESCE\(is_active, TRUE\) = TRUE/i)
    expect(sql).toMatch(/COALESCE\(is_hidden, FALSE\) = FALSE/i)
    expect(sql.indexOf('COALESCE(is_active')).toBeLessThan(sql.indexOf('LIMIT ?'))
  })

  it('returns only verified catalog-backed baseline families and never inflates scores', async () => {
    const rows = [
      program({ id: 'tn-medicaid', title: 'Tennessee Medicaid / TennCare', category: 'healthcare' }),
      program({ id: 'tn-snap', title: 'SNAP Supplemental Nutrition Assistance Program', category: 'food' }),
      program({ id: 'tn-liheap', title: 'Tennessee LIHEAP Home Energy Assistance', category: 'utilities' }),
      program({ id: 'fed-ssdi', title: 'Social Security Disability Insurance (SSDI)', category: 'disability', national: true }),
      program({
        id: 'thin-medicaid',
        title: 'Medicaid',
        category: 'healthcare',
        national: true,
        description: 'Medicaid.',
        application_url: null,
      }),
      program({
        id: 'fr-notice',
        title: 'Agency Information Collection Activities: Request for Comments',
        category: 'healthcare',
        national: true,
        source_url: 'https://www.federalregister.gov/documents/2026/01/01/example',
        application_url: 'https://www.federalregister.gov/documents/2026/01/01/example',
      }),
      program({
        id: 'tata',
        title: 'Tata Trusts Individual Medical Grants',
        category: 'healthcare',
        state: 'TN',
        sponsor: 'Tata Trusts',
        application_url: 'https://www.tatatrusts.org/our-work/healthcare',
        source_url: 'https://www.tatatrusts.org/our-work/healthcare',
      }),
    ]
    const all = vi.fn(async () => rows)
    const db = { prepare: vi.fn(() => ({ all })) }

    const result = await buildColdStartFundingFallback(db, individualContext(), {
      limit: 6,
      scanLimit: 50,
    })

    expect(result.sources.map((source) => source.cold_start_program_family)).toEqual([
      'medicaid',
      'snap',
      'liheap',
    ])
    expect(result.sources.map((source) => source.id)).toEqual([
      'tn-medicaid',
      'tn-snap',
      'tn-liheap',
    ])
    expect(result.sources.every((source) => source.match_decision === 'review')).toBe(true)
    expect(result.sources.every((source) => source.eligibility_confirmed === false)).toBe(true)
    expect(result.sources.every((source) => source.match_score === source.raw_match_score)).toBe(true)
    expect(result.sources.some((source) => source.id === 'fr-notice')).toBe(false)
    expect(result.sources.some((source) => source.id === 'tata')).toBe(false)
    expect(result.telemetry).toMatchObject({
      attempted: true,
      eligible_profile: true,
      kept: 3,
      families: ['medicaid', 'snap', 'liheap'],
    })
    expect(all).toHaveBeenCalledOnce()
  })

  it('does not query the catalog for an internal profile', async () => {
    const db = { prepare: vi.fn(() => { throw new Error('must not query') }) }
    const result = await buildColdStartFundingFallback(db, {
      profile: { display_name: 'Play Review', primary_type: 'individual' },
    })

    expect(result.sources).toEqual([])
    expect(result.telemetry).toMatchObject({ attempted: true, eligible_profile: false })
    expect(db.prepare).not.toHaveBeenCalled()
  })
})
