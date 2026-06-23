/**
 * OpenStreetMap prospect source — the free, keyless geo-local replacement for
 * Google Maps. Verifies the source maps Overpass places into Yana prospects,
 * dedupes, respects the limit, and honestly no-ops without a location; plus the
 * provider's element/address normalization. No network (searchPlaces injected).
 */
import { describe, it, expect } from 'vitest'
import { makeOpenStreetMapSource } from '../services/yana/yanaProspectSources.js'
import { __osm__ } from '../services/yana/osmProvider.js'

const FAKE_PLACES = [
  { name: 'Cleveland Community Foundation', website: 'https://ccf.org', address: '1 Main St, Cleveland, TN', phone: null, place_id: 'osm:node/1', types: ['foundation'], source: 'openstreetmap' },
  { name: 'Grace Community Center', website: null, address: 'Cleveland, TN', phone: '423-555-0100', place_id: 'osm:way/2', types: ['community_centre'], source: 'openstreetmap' },
  { name: 'Cleveland Community Foundation', website: 'https://ccf.org', address: null, phone: null, place_id: 'osm:node/1', types: ['foundation'], source: 'openstreetmap' }, // dup of #1
]

describe('makeOpenStreetMapSource', () => {
  it('maps OSM places into Yana prospects, deduped, tagged source=openstreetmap', async () => {
    const src = makeOpenStreetMapSource({ searchPlaces: async () => FAKE_PLACES })
    const out = await src.discover({ location: 'Cleveland, TN', limit: 10 })
    expect(out.length).toBe(2) // the duplicate collapsed
    expect(out[0].organization_name).toBe('Cleveland Community Foundation')
    expect(out.every((p) => p.source === 'openstreetmap')).toBe(true)
  })

  it('honestly no-ops (no network) when there is no location to anchor on', async () => {
    let called = false
    const src = makeOpenStreetMapSource({ searchPlaces: async () => { called = true; return FAKE_PLACES } })
    const out = await src.discover({ limit: 10 }) // no location
    expect(out).toEqual([])
    expect(called).toBe(false)
  })

  it('respects the limit', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Org ${i}`, source: 'openstreetmap', place_id: `osm:node/${i}` }))
    const src = makeOpenStreetMapSource({ searchPlaces: async () => many })
    const out = await src.discover({ location: 'X', limit: 5 })
    expect(out.length).toBe(5)
  })
})

describe('osmProvider normalization', () => {
  it('composes a single-line address from addr:* tags', () => {
    expect(__osm__.composeAddress({ 'addr:housenumber': '12', 'addr:street': 'Oak Ave', 'addr:city': 'Cleveland', 'addr:state': 'TN', 'addr:postcode': '37312' }))
      .toBe('12 Oak Ave, Cleveland, TN 37312')
    expect(__osm__.composeAddress({})).toBeNull()
  })

  it('normalizes an Overpass element (name + website/contact + type)', () => {
    const p = __osm__.normalizeElement({ type: 'node', id: 9, lat: 35.1, lon: -84.9, tags: { name: 'Hope Charity', office: 'charity', 'contact:website': 'https://hope.org' } })
    expect(p.name).toBe('Hope Charity')
    expect(p.website).toBe('https://hope.org')
    expect(p.types).toEqual(['charity'])
    expect(p.place_id).toBe('osm:node/9')
    expect(p.source).toBe('openstreetmap')
  })

  it('drops a tagless / nameless element', () => {
    expect(__osm__.normalizeElement({ type: 'node', id: 1 })).toBeNull()
    expect(__osm__.normalizeElement({ type: 'node', id: 1, tags: { office: 'ngo' } })).toBeNull() // no name
  })
})
