/**
 * Unit tests for backend/services/yana/googleMapsProvider.js
 *
 * Proves the contract Yana relies on:
 *   1. searchPlaces parses Places v1 Text Search results and returns websites
 *      from the SAME call (no separate Details lookup).
 *   2. No key → [] with no throw (honest NOOP).
 *   3. Quota (429) / billing (402) / non-200 / network error → [] (failure-tolerant).
 *   4. The request uses the documented endpoint, X-Goog-Api-Key, and field mask.
 */

import { describe, it, expect, vi } from 'vitest'
import { searchPlaces, getGoogleMapsApiKey, __googleMaps__ } from '../services/yana/googleMapsProvider.js'

function okResponse(json) {
  return { ok: true, status: 200, json: async () => json }
}

const SAMPLE = {
  places: [
    {
      id: 'PLACE_1',
      displayName: { text: 'Helping Hands Foundation', languageCode: 'en' },
      formattedAddress: '123 Main St, Nashville, TN 37201, USA',
      websiteUri: 'https://helpinghands.org',
      nationalPhoneNumber: '(615) 555-0100',
      types: ['non_profit_organization', 'point_of_interest'],
      location: { latitude: 36.16, longitude: -86.78 },
    },
    {
      id: 'PLACE_2',
      displayName: { text: 'Community Food Bank' },
      formattedAddress: '456 Oak Ave, Nashville, TN',
      // no websiteUri
      types: ['food_bank'],
    },
  ],
}

describe('getGoogleMapsApiKey', () => {
  it('prefers GOOGLE_MAPS_API_KEY, falls back to GOOGLE_PLACES_API_KEY', () => {
    expect(getGoogleMapsApiKey({ GOOGLE_MAPS_API_KEY: 'a', GOOGLE_PLACES_API_KEY: 'b' })).toBe('a')
    expect(getGoogleMapsApiKey({ GOOGLE_PLACES_API_KEY: 'b' })).toBe('b')
    expect(getGoogleMapsApiKey({})).toBe(null)
  })
})

describe('searchPlaces', () => {
  it('parses places and returns websites in one call', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SAMPLE))
    const out = await searchPlaces(
      { query: 'nonprofit organizations', location: 'Nashville TN', limit: 10 },
      { apiKey: 'KEY', fetchImpl },
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      name: 'Helping Hands Foundation',
      website: 'https://helpinghands.org',
      address: '123 Main St, Nashville, TN 37201, USA',
      phone: '(615) 555-0100',
      place_id: 'PLACE_1',
      source: 'google_maps',
      lat: 36.16,
      lng: -86.78,
    })
    expect(out[0].types).toContain('non_profit_organization')
    // Second place has no website — normalized to null, not dropped.
    expect(out[1].name).toBe('Community Food Bank')
    expect(out[1].website).toBe(null)

    // Verify the request shape: NEW Places endpoint, key header, field mask.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe(__googleMaps__.PLACES_TEXT_SEARCH_ENDPOINT)
    expect(opts.method).toBe('POST')
    expect(opts.headers['X-Goog-Api-Key']).toBe('KEY')
    expect(opts.headers['X-Goog-FieldMask']).toContain('places.websiteUri')
    const body = JSON.parse(opts.body)
    expect(body.textQuery).toBe('nonprofit organizations Nashville TN')
  })

  it('returns [] and does not throw when no key is set (and does not fetch)', async () => {
    const fetchImpl = vi.fn()
    const out = await searchPlaces({ query: 'x' }, { env: {}, fetchImpl })
    expect(out).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns [] on quota (429) and billing (402) without throwing', async () => {
    const out429 = await searchPlaces({ query: 'x' }, { apiKey: 'KEY', fetchImpl: async () => ({ ok: false, status: 429 }) })
    const out402 = await searchPlaces({ query: 'x' }, { apiKey: 'KEY', fetchImpl: async () => ({ ok: false, status: 402 }) })
    expect(out429).toEqual([])
    expect(out402).toEqual([])
  })

  it('returns [] on a non-200 error response', async () => {
    const out = await searchPlaces({ query: 'x' }, { apiKey: 'KEY', fetchImpl: async () => ({ ok: false, status: 500 }) })
    expect(out).toEqual([])
  })

  it('returns [] when the network call throws', async () => {
    const out = await searchPlaces(
      { query: 'x' },
      { apiKey: 'KEY', fetchImpl: async () => { throw new Error('ECONNRESET') } },
    )
    expect(out).toEqual([])
  })

  it('returns [] for an empty query', async () => {
    const fetchImpl = vi.fn()
    const out = await searchPlaces({ query: '   ' }, { apiKey: 'KEY', fetchImpl })
    expect(out).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
