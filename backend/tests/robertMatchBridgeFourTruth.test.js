import { describe, expect, it } from 'vitest'

import {
  catalogRowToCrawlerOsOpportunity,
  scoreOpportunityForProfile,
} from '../services/robert/robertMatchBridge.js'

const PROFILE_CONTEXT = {
  profile: {
    id: 'p-student',
    display_name: 'Jordan Lee',
    primary_type: 'student',
    applicant_type: 'student',
    state: 'TN',
    city: 'Murfreesboro',
    zip: '37132',
    needs: ['education', 'housing'],
    interests: ['nursing', 'community health'],
    tags: ['first generation'],
    funding_amount_needed: 8000,
  },
  sections: {
    basic_information: {
      first_name: 'Jordan',
      last_name: 'Lee',
      state: 'TN',
      city: 'Murfreesboro',
      zip_code: '37132',
      email: 'jordan@example.edu',
      phone: '615-555-0101',
      date_of_birth: '2006-02-01',
    },
    education: {
      school_name: 'Middle Tennessee State University',
      enrollment_status: 'enrolled_full_time',
      gpa: 3.7,
      intended_major: 'Nursing',
      expected_graduation: '2028',
      fafsa_completed: true,
    },
    financial_information: {
      household_income: 32000,
      household_size: 4,
      funding_amount_needed: 8000,
    },
    housing: {
      housing_status: 'renting',
      monthly_rent: 850,
      housing_need: 'off-campus housing',
    },
    demographics: { first_generation: true },
  },
  signals: { state: 'TN', city: 'Murfreesboro', zip: '37132' },
}

function verifiedCatalogRow(overrides = {}) {
  return {
    id: 'opp-tsaa',
    source: 'tn_tsac',
    opportunity_kind: 'DIRECT_GRANT',
    title: 'Tennessee Student Assistance Award',
    sponsor: 'Tennessee Student Assistance Corporation',
    description: 'Need-based education funding for eligible Tennessee college students.',
    applicant_types_json: JSON.stringify(['student']),
    need_categories_json: JSON.stringify(['education']),
    is_national: 0,
    state: 'TN',
    amount_max: 4000,
    application_url: 'https://www.tn.gov/collegepays/tsaa/apply',
    source_url: 'https://www.tn.gov/collegepays/financial-aid/tsaa.html',
    source_trust_tier: 'OFFICIAL_HTML',
    reality_status: 'verified',
    content_hash: 'sha256:catalog-evidence',
    fetched_at: '2026-09-03T00:00:00.000Z',
    eligibility_bullets_json: JSON.stringify([
      'Eligible applicants: Tennessee resident students enrolled in college',
    ]),
    ...overrides,
  }
}

describe('Robert match bridge four-truth authority', () => {
  it('adapts catalog evidence without fabricating missing proof fields', () => {
    const adapted = catalogRowToCrawlerOsOpportunity(verifiedCatalogRow())
    expect(adapted).toMatchObject({
      kind: 'DIRECT_GRANT',
      applicant_types: ['student'],
      need_categories: ['education'],
      geography: { national: false, states: ['TN'] },
      reality_status: 'VERIFIED',
      evidence: {
        url: 'https://www.tn.gov/collegepays/financial-aid/tsaa.html',
        content_hash: 'sha256:catalog-evidence',
        fetched_at: '2026-09-03T00:00:00.000Z',
      },
    })
  })

  it('uses the production default matcher and returns inspectable positive proof', async () => {
    const decision = await scoreOpportunityForProfile({
      profileContext: PROFILE_CONTEXT,
      opportunity: verifiedCatalogRow(),
    })

    expect(decision.decision).toBe('accept')
    expect(decision.matchExplain?.four_truth_proof).toMatchObject({
      direct_funding: true,
      all_passed: true,
      real: { passed: true },
      relatable: { passed: true },
      meets_profile_need: { passed: true, profile_needs_defaulted: false },
      profile_qualifies: { passed: true },
    })
    expect(decision.matchExplain.four_truth_proof.meets_profile_need.matched_needs)
      .toContain('education')
  })

  it('cannot promote a catalog score when reality evidence is incomplete', async () => {
    const decision = await scoreOpportunityForProfile({
      profileContext: PROFILE_CONTEXT,
      opportunity: verifiedCatalogRow({ content_hash: null }),
    })

    expect(decision.decision).not.toBe('accept')
    expect(decision.matchExplain?.four_truth_proof.real.passed).toBe(false)
    expect(decision.matchExplain?.four_truth_proof.all_passed).toBe(false)
    expect(decision.reasons.join(' ')).toMatch(/four-truth gate held/i)
  })

  it('preserves deterministic injected matcher compatibility', async () => {
    const injected = async (profile, opportunity, options) => ({
      score: profile.id === 'p-student' && opportunity.id === 'opp-tsaa' &&
        options.profileSections.education.gpa === 3.7 ? 88 : 0,
      decision: 'ACCEPT',
      eligible: true,
      reasons: ['injected'],
      match_explain: { four_truth_proof: { all_passed: true } },
    })
    const decision = await scoreOpportunityForProfile({
      profileContext: PROFILE_CONTEXT,
      opportunity: verifiedCatalogRow(),
      computeMatchDecision: injected,
    })
    expect(decision).toMatchObject({
      score: 88,
      decision: 'ACCEPT',
      reasons: ['injected'],
      eligible: true,
    })
  })
})
