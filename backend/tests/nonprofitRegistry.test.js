/**
 * nonprofitRegistry.test.js
 *
 * Unit tests for the ProPublica Nonprofit Explorer verification provider.
 * The HTTP layer (node-fetch) is FULLY MOCKED — NO TEST HITS A LIVE API.
 *
 * Coverage:
 *   - happy path (EIN + name → verified, NTEE, revenue band)
 *   - not-found (404 / no confident name match → apiAnswered:true, verified:false)
 *   - API error / timeout → apiAnswered:false (graceful degrade, NEUTRAL)
 *   - caching (a repeat lookup does not re-hit the network)
 *   - pure helpers (revenueBand, nameSimilarity, normalizeEin)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const ORG = JSON.parse(readFileSync(path.join(here, 'fixtures/verification/propublicaOrganization.json'), 'utf8'))
const SEARCH = JSON.parse(readFileSync(path.join(here, 'fixtures/verification/propublicaSearch.json'), 'utf8'))

// Mock node-fetch BEFORE importing the module under test.
const fetchMock = vi.fn()
vi.mock('node-fetch', () => ({ default: (...args) => fetchMock(...args) }))

const {
  lookupByEin,
  lookupByName,
  revenueBand,
  nameSimilarity,
  normalizeEin,
  mapOrganization,
  _clearCache,
} = await import('../services/verification/nonprofitRegistry.js')

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

beforeEach(() => {
  fetchMock.mockReset()
  _clearCache()
  process.env.ENABLE_REGISTRY_VERIFICATION = 'true'
})

describe('pure helpers', () => {
  it('revenueBand buckets by the tier taxonomy', () => {
    expect(revenueBand(0)).toBe('unknown')
    expect(revenueBand(null)).toBe('unknown')
    expect(revenueBand(10000)).toBe('micro')
    expect(revenueBand(100000)).toBe('small')
    expect(revenueBand(1000000)).toBe('mid')
    expect(revenueBand(50000000)).toBe('large')
  })

  it('normalizeEin keeps only valid 9-digit EINs', () => {
    expect(normalizeEin('53-0196605')).toBe('530196605')
    expect(normalizeEin('530196605')).toBe('530196605')
    expect(normalizeEin('12345')).toBeNull()
    expect(normalizeEin(null)).toBeNull()
  })

  it('nameSimilarity is high for the same org and low for unrelated names', () => {
    expect(nameSimilarity('American National Red Cross', 'American National Red Cross')).toBe(1)
    expect(nameSimilarity('American Red Cross', 'American National Red Cross')).toBeGreaterThan(0.6)
    expect(nameSimilarity('American Red Cross', 'Quantum Widgets LLC')).toBeLessThan(0.4)
  })

  it('mapOrganization marks a 501(c)(3) as verified + tax-exempt', () => {
    const m = mapOrganization(ORG.organization, 3286000000)
    expect(m.apiAnswered).toBe(true)
    expect(m.verified).toBe(true)
    expect(m.is501c3).toBe(true)
    expect(m.ntee).toBe('P200')
    expect(m.revenue_band).toBe('large')
  })
})

describe('lookupByEin', () => {
  it('happy path: returns verified org + latest-year revenue band', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ORG))
    const r = await lookupByEin('53-0196605')
    expect(r.apiAnswered).toBe(true)
    expect(r.verified).toBe(true)
    expect(r.ein).toBe('530196605')
    expect(r.ntee).toBe('P200')
    // Latest filing (2022) revenue wins over the 2021 one.
    expect(r.revenue).toBe(3286000000)
    expect(r.revenue_band).toBe('large')
  })

  it('404 → apiAnswered:true, verified:false (the API said: not a listed org)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 404 }))
    const r = await lookupByEin('99-9999999')
    expect(r.apiAnswered).toBe(true)
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('not_found')
  })

  it('5xx → apiAnswered:false (graceful degrade, NEUTRAL)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 503 }))
    const r = await lookupByEin('53-0196605')
    expect(r.apiAnswered).toBe(false)
    expect(r.verified).toBeNull()
  })

  it('network/timeout error → apiAnswered:false, never throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('aborted'))
    const r = await lookupByEin('53-0196605')
    expect(r.apiAnswered).toBe(false)
    expect(r.verified).toBeNull()
  })

  it('caches a definitive answer (no second network call)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ORG))
    await lookupByEin('53-0196605')
    await lookupByEin('53-0196605')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache a transient error (stays retryable)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'))
    await lookupByEin('53-0196605')
    fetchMock.mockResolvedValueOnce(jsonResponse(ORG))
    const r = await lookupByEin('53-0196605')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(r.verified).toBe(true)
  })

  it('returns neutral(disabled) when the flag is off — no network', async () => {
    process.env.ENABLE_REGISTRY_VERIFICATION = 'false'
    const r = await lookupByEin('53-0196605')
    expect(r.apiAnswered).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('lookupByName', () => {
  it('happy path: search → confident match → hydrate org by EIN', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SEARCH)) // search.json
      .mockResolvedValueOnce(jsonResponse(ORG))    // organizations/<ein>.json
    const r = await lookupByName('American National Red Cross')
    expect(r.apiAnswered).toBe(true)
    expect(r.verified).toBe(true)
    expect(r.ein).toBe('530196605')
    expect(r.nameMatchScore).toBeGreaterThan(0.9)
  })

  it('no confident match → apiAnswered:true, verified:false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ organizations: [{ ein: 1, name: 'Totally Unrelated Foundation' }] }))
    const r = await lookupByName('American National Red Cross')
    expect(r.apiAnswered).toBe(true)
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('no_confident_match')
  })

  it('search API error → apiAnswered:false (NEUTRAL)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    const r = await lookupByName('American National Red Cross')
    expect(r.apiAnswered).toBe(false)
    expect(r.verified).toBeNull()
  })
})
