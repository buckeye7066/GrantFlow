/**
 * Geo crawler (nationalZipCrawler) — placeholder removal + profile-driven query.
 *
 * Pins two canonical-rule fixes:
 *
 *  (a) The crawler no longer manufactures TEMPLATED PLACEHOLDER directory rows
 *      ("United Way near <city>, <state>", "Community Action Agency near ...",
 *      "Food Bank resources near ...", and the Canadian 211/Food Banks Canada/
 *      United Way Centraide analogues). buildBaselineDirectorySources and its
 *      Canadian sibling must now emit NOTHING per ZIP. This enforces
 *      canonical_rules.md "no placeholder funding / real sources only" (Goal #1)
 *      and G7's "REAL means non-placeholder, deduped".
 *
 *  (b) When a profile context with keywords is supplied, the Grants.gov query
 *      terms reflect the profile (via sourceRegistry.buildGrantsGovQueryTerms),
 *      NOT the generic ['community development', ...] fallback. The generic
 *      fallback is retained ONLY for admin nationwide crawls with no profile.
 *
 * Network is mocked at the grantsGovClient.searchGrants boundary so we can
 * inspect the exact terms the crawler queries with, without hitting Grants.gov.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

// Capture every keyword the crawler sends to Grants.gov.
const grantsGovCalls = []
vi.mock('../services/crawlers/grantsGovClient.js', () => ({
  searchGrants: vi.fn(async (keyword) => {
    grantsGovCalls.push(keyword)
    // Return no hits so the test focuses on which terms were queried, not mapping.
    return { ok: true, opportunities: [] }
  }),
  searchGrantsBatch: vi.fn(async () => ({ ok: true, opportunities: [] })),
  testConnectivity: vi.fn(async () => ({ ok: true })),
  GRANTS_GOV_DETAIL: 'https://www.grants.gov/search-results-detail',
}))

const { __test } = await import('../services/crawlers/nationalZipCrawler.js')
const { buildBaselineDirectorySources, buildCanadianBaselineDirectorySources, searchGrantsGovByZip } = __test

const GENERIC_FALLBACK = ['community development', 'rural development', 'public safety', 'workforce development']

beforeEach(() => {
  grantsGovCalls.length = 0
})

describe('(a) no manufactured placeholder directory stubs', () => {
  it('buildBaselineDirectorySources emits NO rows for a US ZIP', () => {
    const rows = buildBaselineDirectorySources({ zip: '57718', meta: { city: 'Bradley', state: 'SD' } })
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(0)
  })

  it('buildCanadianBaselineDirectorySources emits NO rows for a Canadian FSA', () => {
    const rows = buildCanadianBaselineDirectorySources({ code: 'K1A', meta: { city: 'Ottawa', state: 'ON' } })
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(0)
  })

  it('never produces a templated "X near <city>" placeholder title', () => {
    const us = buildBaselineDirectorySources({ zip: '57718', meta: { city: 'Bradley', state: 'SD' } })
    const ca = buildCanadianBaselineDirectorySources({ code: 'K1A', meta: { city: 'Ottawa', state: 'ON' } })
    const titles = [...us, ...ca].map((r) => String(r?.title || ''))
    const banned = [/United Way near/i, /Community Action Agency near/i, /Food Bank resources near/i, /211 Canada — .* near/i]
    for (const re of banned) {
      expect(titles.some((t) => re.test(t))).toBe(false)
    }
  })
})

describe('(b) profile-driven Grants.gov query terms', () => {
  const coords = { lat: 44.7, lng: -97.0, city: 'Bradley', state: 'SD' }

  it('uses profile-derived terms (not the generic fallback) when a profile is supplied', async () => {
    const profileContext = {
      profile: { primary_type: 'volunteer_fire_department' },
      signals: { needs: ['equipment', 'training'], interests: ['wildfire'] },
    }
    await searchGrantsGovByZip('57718', coords, { profileContext })

    // The profile's type + needs + interests must have been queried.
    expect(grantsGovCalls).toContain('volunteer fire department')
    expect(grantsGovCalls).toContain('equipment')
    expect(grantsGovCalls).toContain('training')
    expect(grantsGovCalls).toContain('wildfire')

    // And NONE of the generic fallback terms should be queried.
    for (const generic of GENERIC_FALLBACK) {
      expect(grantsGovCalls).not.toContain(generic)
    }
  })

  it('falls back to the generic term set when NO profile context is supplied', async () => {
    await searchGrantsGovByZip('57718', coords, {})
    for (const generic of GENERIC_FALLBACK) {
      expect(grantsGovCalls).toContain(generic)
    }
  })

  it('honors explicit searchTerms over both the profile and the fallback', async () => {
    await searchGrantsGovByZip('57718', coords, {
      searchTerms: ['dialysis', 'kidney'],
      profileContext: { profile: { primary_type: 'nonprofit' } },
    })
    expect(grantsGovCalls).toContain('dialysis')
    expect(grantsGovCalls).toContain('kidney')
    expect(grantsGovCalls).not.toContain('nonprofit')
    for (const generic of GENERIC_FALLBACK) {
      expect(grantsGovCalls).not.toContain(generic)
    }
  })

  it('PII-looking profile terms never reach the Grants.gov query', async () => {
    const profileContext = {
      profile: { primary_type: 'individual' },
      signals: { needs: ['123-45-6789', 'food assistance'] },
    }
    await searchGrantsGovByZip('57718', coords, { profileContext })
    expect(grantsGovCalls).toContain('food assistance')
    expect(grantsGovCalls.some((t) => /\d{3}-?\d{2}-?\d{4}/.test(t))).toBe(false)
  })
})
