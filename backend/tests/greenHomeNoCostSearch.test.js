import { describe, expect, it, vi } from 'vitest'
import {
  canonicalGreenHomeProfileRecheck,
  minimizeGreenHomeSearchContext,
  searchGreenHomeNoCostPrograms,
} from '../services/greenHomeNoCostSearch.js'
import {
  GREEN_HOME_NO_COST_POLICY_VERSION,
  officialGreenHomePaths,
} from '../services/greenHomeNoCostPolicy.js'

const NOW = new Date('2026-08-10T00:00:00Z')

function reportWith(results) {
  return {
    profile_id: 'profile-1',
    items: [{
      item: 'home weatherization',
      results,
      lanes: {
        catalog: { scanned: 9, matched: 4, error: null },
        web: { attempted: true, raw_results: 12, matched: 3, error: null },
      },
    }],
  }
}

function trustedCatalog(overrides = {}) {
  return {
    id: 'direct-install',
    title: 'No-cost insulation direct install',
    description: 'Income-qualified households receive insulation at no cost.',
    source_url: 'https://energy.example.gov/no-cost-insulation',
    result_source: 'catalog',
    source_trust_tier: 'official_portal',
    source_reviewed_at: '2026-08-09T00:00:00Z',
    source_reviewed_by: 'test-reviewer',
    source_review_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    link_status: 'ok',
    last_verified_at: '2026-08-09T00:00:00Z',
    need_score: 40,
    ...overrides,
  }
}

describe('searchGreenHomeNoCostPrograms', () => {
  it('shows only proven no-cost paths and keeps LIHEAP as review-only', async () => {
    const searchItemNeedsImpl = vi.fn().mockResolvedValue(reportWith([
      trustedCatalog(),
      trustedCatalog({
        id: 'tax-credit',
        title: 'Residential clean energy tax credit',
        description: 'Tax credit for purchasing rooftop solar panels.',
      }),
      trustedCatalog({
        id: 'unknown-cost',
        title: 'Heat pump assistance program',
        description: 'Heat pump assistance may be available. Contact the provider for cost terms.',
      }),
      {
        id: 'unknown-web',
        title: 'Free residential wind installation',
        description: 'Free small wind installation for selected homeowners.',
        url: 'https://unknown.example/wind',
        result_source: 'web_search',
        need_score: 70,
      },
    ]))

    const privateContext = {
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
      sections: { documents: { uploaded_text: 'private uploaded document content' } },
    }

    const result = await searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      profileContext: privateContext,
      now: NOW,
      searchItemNeedsImpl,
      officialGreenHomePathsImpl: officialGreenHomePaths,
    })

    const searchOptions = searchItemNeedsImpl.mock.calls[0][1]
    expect(searchOptions.profileContext).toEqual({
      profile: { primary_type: 'family', state: 'TN' },
      signals: { entityType: 'family', location: { state: 'TN' } },
    })
    expect(JSON.stringify(searchOptions.profileContext)).not.toMatch(
      /Private Household|private@example|Private Lane|12345|diagnosis|veteran identifier|uploaded document/i,
    )
    expect(result.programs.map((program) => program.id)).toEqual([
      'doe-weatherization-assistance',
      'direct-install',
    ])
    expect(result.review_reasons).toEqual(expect.arrayContaining([
      { reason: 'no_cost_not_proven', count: 2 },
      { reason: 'source_not_yet_verified', count: 1 },
    ]))
    expect(result.excluded_reasons).toContainEqual({ reason: 'tax_credit', count: 1 })
    expect(result.search_coverage).toMatchObject({
      searched_items: 1,
      catalog_verification_requested: 3,
      catalog_verification_enriched: 0,
      catalog_full_profile_rechecks: 0,
    })
    expect(result.search_privacy).toMatchObject({
      sensitive_fields_transmitted: false,
      catalog_matching_context: 'full_server_side_profile_recheck',
    })
  })

  it('rejects organization profiles before household locators or external search are added', async () => {
    const searchItemNeedsImpl = vi.fn()
    await expect(searchGreenHomeNoCostPrograms(null, {
      profileId: 'org-1',
      profileContext: { profile: { primary_type: 'nonprofit', state: 'TN' } },
      searchItemNeedsImpl,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'green_home_household_profile_required',
    })
    expect(searchItemNeedsImpl).not.toHaveBeenCalled()
  })

  it('rechecks persisted catalog candidates with the complete server-side profile', async () => {
    const report = reportWith([trustedCatalog()])
    const row = {
      ...trustedCatalog(),
      categories: '[]',
      keywords: '[]',
      entity_types_allowed: '["individual"]',
      need_types_supported: '["weatherization"]',
    }
    const db = {
      prepare: vi.fn(() => ({ all: vi.fn().mockResolvedValue([row]) })),
    }
    const computeMatchDecisionImpl = vi.fn((context) => {
      expect(context.profile.exact_income).toBe(12345)
      expect(context.profile.disability_diagnosis).toBe('private diagnosis')
      return { decision: 'REJECT', score: 0, explanation: 'source-defined hard mismatch' }
    })

    const result = await searchGreenHomeNoCostPrograms(db, {
      profileId: 'profile-1',
      profileContext: {
        profile: {
          primary_type: 'family',
          state: 'TN',
          exact_income: 12345,
          disability_diagnosis: 'private diagnosis',
        },
      },
      now: NOW,
      searchItemNeedsImpl: async () => report,
      officialGreenHomePathsImpl: () => [],
      computeMatchDecisionImpl,
    })

    expect(computeMatchDecisionImpl).toHaveBeenCalledTimes(1)
    expect(result.programs).toHaveLength(0)
    expect(result.excluded_reasons).toContainEqual({ reason: 'canonical_profile_reject', count: 1 })
    expect(result.search_coverage.catalog_full_profile_rechecks).toBe(1)
  })

  it('deduplicates the same source and ranks an official locator first', async () => {
    const shared = trustedCatalog({
      id: 'shared',
      title: 'Free weatherization and heat-pump installation',
      description: 'A no-cost program for qualifying households.',
      source_url: 'https://energy.example.gov/free-upgrades?utm_source=test',
    })
    const result = await searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      profileContext: { profile: { primary_type: 'family', state: 'TN' } },
      now: NOW,
      searchItemNeedsImpl: async () => ({
        items: [
          { item: 'weatherization', results: [{ ...shared, need_score: 25 }], lanes: {} },
          { item: 'heat pump', results: [{ ...shared, source_url: 'https://energy.example.gov/free-upgrades', need_score: 45 }], lanes: {} },
        ],
      }),
      officialGreenHomePathsImpl: officialGreenHomePaths,
    })

    expect(result.programs.map((program) => program.id)).toEqual([
      'doe-weatherization-assistance',
      'shared',
    ])
    expect(result.programs[1].need_score).toBe(45)
    expect(result.programs[1].matched_green_home_items).toEqual(['weatherization', 'heat pump'])
  })

  it('exposes catalog metadata-query failure as partial coverage', async () => {
    const db = { prepare: vi.fn(() => ({ all: vi.fn().mockRejectedValue(new Error('db unavailable')) })) }
    const result = await searchGreenHomeNoCostPrograms(db, {
      profileId: 'profile-1',
      profileContext: { profile: { primary_type: 'family', state: 'TN' } },
      now: NOW,
      searchItemNeedsImpl: async () => reportWith([trustedCatalog()]),
      officialGreenHomePathsImpl: () => [],
    })
    expect(result.search_coverage.source_errors).toContainEqual(expect.objectContaining({
      lane: 'catalog_verification',
      error: 'db unavailable',
    }))
  })

  it('minimizes malformed state and organization values safely', () => {
    expect(minimizeGreenHomeSearchContext({
      profile: { primary_type: 'Church Ministry 501(c)(3)', state: 'Tennessee' },
    })).toEqual({
      profile: { primary_type: 'nonprofit' },
      signals: { entityType: 'nonprofit', location: {} },
    })
  })

  it('exposes the canonical recheck helper for direct regression coverage', () => {
    const matcher = vi.fn(() => ({ decision: 'ACCEPT', score: 88 }))
    expect(canonicalGreenHomeProfileRecheck(
      { title: 'Weatherization', categories: '[]', keywords: '[]' },
      { profile: { primary_type: 'family' } },
      matcher,
    )).toMatchObject({ ok: true, match: { decision: 'ACCEPT', score: 88 } })
  })

  it('requires a profile id and valid injected dependencies', async () => {
    await expect(searchGreenHomeNoCostPrograms(null, {})).rejects.toMatchObject({ statusCode: 400 })
    await expect(searchGreenHomeNoCostPrograms(null, {
      profileId: 'profile-1',
      profileContext: { profile: { primary_type: 'family' } },
      searchItemNeedsImpl: null,
    })).rejects.toMatchObject({ statusCode: 500 })
  })
})
