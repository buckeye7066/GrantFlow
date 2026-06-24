/**
 * censusGeo.test.js
 *
 * Unit tests for the US Census Geocoder verification provider.
 * The HTTP layer (node-fetch) is FULLY MOCKED — NO TEST HITS A LIVE API.
 *
 * Coverage:
 *   - happy path (address → county / state / 5-digit FIPS)
 *   - no-match (API answered, addressMatches empty → resolved:false)
 *   - API error / timeout → apiAnswered:false (graceful degrade, NEUTRAL)
 *   - caching (a repeat resolve does not re-hit the network)
 *   - mapGeographies pure mapping
 *   - feature-flag off → no network
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const CENSUS = JSON.parse(readFileSync(path.join(here, 'fixtures/verification/censusGeographies.json'), 'utf8'))

const fetchMock = vi.fn()
vi.mock('node-fetch', () => ({ default: (...args) => fetchMock(...args) }))

const {
  resolveAddress,
  resolveZip,
  mapGeographies,
  _clearCache,
} = await import('../services/verification/censusGeo.js')

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

beforeEach(() => {
  fetchMock.mockReset()
  _clearCache()
  process.env.ENABLE_CENSUS_GEO = 'true'
})

describe('mapGeographies (pure)', () => {
  it('extracts county, state abbreviation and 5-digit FIPS', () => {
    const m = mapGeographies(CENSUS.result.addressMatches[0].geographies)
    expect(m.resolved).toBe(true)
    expect(m.county).toBe("Prince George's County")
    expect(m.state).toBe('MD')
    expect(m.fips).toBe('24033')
  })

  it('returns neutral when there is no county node', () => {
    const m = mapGeographies({ States: [] })
    expect(m.resolved).toBe(false)
    expect(m.apiAnswered).toBe(false)
  })
})

describe('resolveAddress', () => {
  it('happy path: resolves a street address to county/state/FIPS', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CENSUS))
    const r = await resolveAddress({ street: '4600 Silver Hill Rd', city: 'Washington', state: 'DC', zip: '20233' })
    expect(r.apiAnswered).toBe(true)
    expect(r.resolved).toBe(true)
    expect(r.county).toBe("Prince George's County")
    expect(r.fips).toBe('24033')
  })

  it('no addressMatches → apiAnswered:true, resolved:false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { addressMatches: [] } }))
    const r = await resolveAddress({ street: '1 Nowhere Rd', city: 'X', state: 'ZZ', zip: '00000' })
    expect(r.apiAnswered).toBe(true)
    expect(r.resolved).toBe(false)
    expect(r.reason).toBe('no_match')
  })

  it('API error / timeout → apiAnswered:false (graceful degrade)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('aborted'))
    const r = await resolveAddress({ street: '4600 Silver Hill Rd', state: 'DC' })
    expect(r.apiAnswered).toBe(false)
    expect(r.resolved).toBe(false)
  })

  it('5xx → apiAnswered:false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }))
    const r = await resolveAddress({ street: '4600 Silver Hill Rd', state: 'DC' })
    expect(r.apiAnswered).toBe(false)
  })

  it('no street → neutral, no network', async () => {
    const r = await resolveAddress({ city: 'Washington', state: 'DC' })
    expect(r.apiAnswered).toBe(false)
    expect(r.reason).toBe('no_street')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches a definitive answer (no second network call)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CENSUS))
    const args = { street: '4600 Silver Hill Rd', city: 'Washington', state: 'DC', zip: '20233' }
    await resolveAddress(args)
    await resolveAddress(args)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('flag off → no network', async () => {
    process.env.ENABLE_CENSUS_GEO = 'false'
    const r = await resolveAddress({ street: '4600 Silver Hill Rd', state: 'DC' })
    expect(r.reason).toBe('disabled')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('resolveZip (offline dataset + optional live FIPS)', () => {
  it('rejects an invalid ZIP without touching the network', async () => {
    const r = await resolveZip('abc')
    expect(r.resolved).toBe(false)
    expect(r.reason).toBe('invalid_zip')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves a real ZIP from the offline dataset when the live geocoder misses', async () => {
    // Force the live coordinate geocode to miss so we exercise the offline path.
    fetchMock.mockResolvedValue(jsonResponse({ result: { geographies: null } }))
    const r = await resolveZip('20233') // Washington, DC area ZIP present in `zipcodes`
    // Offline dataset gives county/state even without a live FIPS.
    expect(r.resolved).toBe(true)
    expect(r.state).toBeTruthy()
  })
})
