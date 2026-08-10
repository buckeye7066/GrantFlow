import { describe, expect, it, vi } from 'vitest'
import {
  minimizeGreenHomeSearchContext,
  searchGreenHomeNoCostPrograms,
} from '../services/greenHomeNoCostSearch.js'

const NOW = new Date('2026-08-10T00:00:00Z')

function reportWith(results) {
  return {
    profile_id: 'profile-1',
    items: [
      {
        item: 'home weatherization',
        results,
        lanes: {
          catalog: { scanned: 9, matched: 4, error: null },
          web: { attempted: true, raw_results: 12, matched: 3, error: null },
        },
      },
    ],
  }
}

const currentOfficialPaths = () => [
  {
    id: 'doe-weatherization-assistance',
    title: 'Weatherization Assistance Program',
    description: 'Official free weatherization assistance path.',
    url: 'https://www.energy.gov/cmei/scep/wap/how-apply-weatherization-assistance',
    source_url: 'https://www.energy.gov/cmei/scep/wap/how-apply-weatherization-assistance',
    result_source: 'official_green_home_locator',
    opportunity_kind: 'directory',
    is_pointer: true,
    no_cost_classification: 'eligible',
    no_cost_reason: 'explicit_no_cost_no_loan_path',
    no_cost_evidence: 'Official free weatherization assistance path.',
    reviewed_at: '2026-08-09',
    source_fresh: true,
    source_age_days: 1,
  },
]

describe('searchGreenHomeNoCostPrograms', () => {
  it('returns only proven, freshly verified no-cost sources and aggregates withheld reasons', async () => {
    const searchItemNeedsImpl = vi.fn().mockResolvedValue(reportWith([
      {
        id: 'direct-install',
        title: 'No-cost insulation direct install',
        description: 'Income-qualified households receive insulation at no cost.',
        source_url: 'https://energy.example.gov/no-cost-insulation',
        result_source: 'catalog',
        source_verified_at: '2026-08-09T00:00:00Z',
        need_score: 40,
      },
      {
        id: 'tax-credit',
        title: 'Residential clean energy tax credit',
        description: 'Tax credit for purchasing rooftop solar panels.',
        source_url: 'https://energy.example.gov/tax-credit',
        result_source: 'catalog',
        source_verified_at: '2026-08-09T00:00:00Z',
        need_score: 80,
      },
      {
        id: 'unknown-cost',
        title: 'Heat pump assistance program',
        description: 'Heat pump assistance may be available. Contact the provider for cost terms.',
        source_url: 'https://energy.example.gov/heat-pump-help',
        result_source: 'catalog',
        source_verified_at: '2026-08-09T00:00:00Z',
        need_score: 60,
      },
      {
        id: 'unknown-web',
        title: 'Free residential wind installation',
        description: 'Free small wind installation for selected homeowners.',
        url: 'https://unknown.example/wind',
        result_source: 'web_search',
        need_score: 70,
      },
    ]))

    const result = await searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      profileContext: {
        profile: {
          id: 'profile-1',
          display_name: 'Private Household Name',
          primary_email: 'private@example.com',
          street_address: '123 Private Lane',
          state: 'TN',
          exact_income: 12345,
          disability_diagnosis: 'private diagnosis',
          veteran_service_number: 'private veteran identifier',
          is_homeowner: true,
          primary_type: 'family',
        },
        sections: {
          documents: { uploaded_text: 'private uploaded document content' },
        },
      },
      now: NOW,
      searchItemNeedsImpl,
      officialGreenHomePathsImpl: currentOfficialPaths,
    })

    expect(searchItemNeedsImpl).toHaveBeenCalledTimes(1)
    const searchOptions = searchItemNeedsImpl.mock.calls[0][1]
    expect(searchOptions).toMatchObject({
      profileId: 'profile-1',
      variant: 'funding',
      profileContext: {
        profile: { primary_type: 'family', state: 'TN' },
        signals: { entityType: 'family', location: { state: 'TN' } },
      },
    })
    expect(JSON.stringify(searchOptions.profileContext)).not.toMatch(
      /Private Household|private@example|Private Lane|12345|diagnosis|veteran identifier|uploaded document/i,
    )
    expect(result.strict_no_cost).toBe(true)
    expect(result.household).toMatchObject({ occupancy: 'homeowner', state: 'TN' })
    expect(result.search_privacy).toMatchObject({
      sensitive_fields_transmitted: false,
      outbound_context: {
        profile: { primary_type: 'family', state: 'TN' },
        signals: { entityType: 'family', location: { state: 'TN' } },
      },
    })
    expect(result.programs.map((program) => program.id)).toEqual([
      'doe-weatherization-assistance',
      'direct-install',
    ])
    expect(result.programs.every((program) => program.no_cost_classification === 'eligible')).toBe(true)
    expect(result.programs.every((program) => program.eligibility_status === 'provider_confirmation_required')).toBe(true)
    expect(result.programs.every((program) => program.no_cost_source_age_days === 1)).toBe(true)
    expect(result.review_count).toBe(2)
    expect(result.review_reasons).toEqual(expect.arrayContaining([
      { reason: 'no_cost_not_proven', count: 1 },
      { reason: 'source_not_yet_verified', count: 1 },
    ]))
    expect(result.excluded_reasons).toContainEqual({ reason: 'tax_credit', count: 1 })
    expect(result.search_coverage).toMatchObject({
      searched_items: 1,
      catalog_scanned: 9,
      catalog_matched_before_no_cost_policy: 4,
      web_attempted: true,
      web_raw: 12,
      web_matched_before_no_cost_policy: 3,
    })
  })

  it('minimizes malformed and organization profile values to a safe broad search context', () => {
    expect(minimizeGreenHomeSearchContext({
      profile: {
        primary_type: 'Church Ministry 501(c)(3)',
        state: 'Tennessee',
        display_name: 'Should never leave the server',
      },
    })).toEqual({
      profile: { primary_type: 'nonprofit' },
      signals: { entityType: 'nonprofit', location: {} },
    })
  })

  it('deduplicates the same fresh official source while retaining all matched upgrade searches', async () => {
    const shared = {
      id: 'shared',
      title: 'Free weatherization and heat-pump installation',
      description: 'A no-cost program for qualifying households.',
      source_url: 'https://energy.example.gov/free-upgrades?utm_source=test',
      result_source: 'catalog',
      source_verified_at: '2026-08-09T00:00:00Z',
    }
    const searchItemNeedsImpl = vi.fn().mockResolvedValue({
      items: [
        { item: 'weatherization', results: [{ ...shared, need_score: 25 }], lanes: {} },
        { item: 'heat pump', results: [{ ...shared, source_url: 'https://energy.example.gov/free-upgrades', need_score: 45 }], lanes: {} },
      ],
    })

    const result = await searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      now: NOW,
      searchItemNeedsImpl,
      officialGreenHomePathsImpl: () => [],
    })

    expect(result.programs).toHaveLength(1)
    expect(result.programs[0].need_score).toBe(45)
    expect(result.programs[0].matched_green_home_items).toEqual(['weatherization', 'heat pump'])
  })

  it('holds otherwise valid sources out of primary results when verification is missing or stale', async () => {
    const searchItemNeedsImpl = vi.fn().mockResolvedValue(reportWith([
      {
        id: 'missing-date',
        title: 'No-cost insulation installation',
        description: 'Free insulation installation for qualifying households.',
        source_url: 'https://energy.example.gov/missing-date',
        result_source: 'catalog',
        source_verified: true,
      },
      {
        id: 'stale-date',
        title: 'No-cost weatherization',
        description: 'Free weatherization for qualifying households.',
        source_url: 'https://energy.example.gov/stale',
        result_source: 'catalog',
        source_verified_at: '2026-01-01T00:00:00Z',
      },
    ]))

    const result = await searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      now: NOW,
      searchItemNeedsImpl,
      officialGreenHomePathsImpl: () => [],
    })

    expect(result.programs).toHaveLength(0)
    expect(result.review_reasons).toEqual(expect.arrayContaining([
      { reason: 'source_verification_date_missing', count: 1 },
      { reason: 'source_verification_stale', count: 1 },
    ]))
  })

  it('keeps stale official locators out of primary results', async () => {
    const result = await searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      now: NOW,
      searchItemNeedsImpl: async () => ({ items: [] }),
      officialGreenHomePathsImpl: () => [{
        id: 'stale-path',
        title: 'Old weatherization page',
        description: 'Free weatherization.',
        url: 'https://energy.example.gov/old',
        no_cost_classification: 'review',
        no_cost_reason: 'official_source_review_stale',
        no_cost_evidence: 'Prior official evidence',
        reviewed_at: '2025-01-01',
        source_fresh: false,
        source_age_days: 500,
      }],
    })

    expect(result.programs).toHaveLength(0)
    expect(result.review_count).toBe(1)
    expect(result.review_reasons).toEqual([
      { reason: 'official_source_review_stale', count: 1 },
    ])
  })

  it('requires a profile id and valid injected dependencies', async () => {
    await expect(searchGreenHomeNoCostPrograms(null, {})).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      searchItemNeedsImpl: null,
    })).rejects.toMatchObject({ statusCode: 500 })
  })
})
