/**
 * osmOverpassElementMapping.test.js
 *
 * GUARD: every well-formed Overpass element must map to a stored local-resource
 * row.
 *
 * `mapOsmElementToOpportunity` derived the element's stable evidence URL from
 *   const osmId = /^d+$/.test(String(element?.id || '')) ? String(element.id) : null
 * — `/^d+$/` (no backslash) matches only literal "d" characters, so a numeric
 * OSM id NEVER matched, `url` was always null, and the very next line
 * (`if (!url) return null`) dropped 100% of Overpass elements. The lane still
 * issued its rate-limited Overpass request and the ZIP still reported
 * `status:'completed'` off the other lanes, so the whole `osm_overpass`
 * local-resource lane read as healthy while storing nothing.
 *
 * This is the repo's silent-no-op-reported-as-success class, so the assertion
 * is deliberately on the OUTPUT ROW, not on the regex.
 */
import { describe, it, expect } from 'vitest'
import { __test } from '../services/crawlers/nationalZipCrawler.js'

const { mapOsmElementToOpportunity } = __test

const COORDS = { lat: 41.38, lng: -82.02, city: 'North Ridgeville', state: 'OH' }

describe('Overpass element -> local resource row', () => {
  it('maps a real numeric-id element to a row with the OSM evidence URL', () => {
    const row = mapOsmElementToOpportunity({
      element: {
        type: 'node',
        id: 123456789,
        tags: { name: 'Community Food Bank', amenity: 'food_bank' },
      },
      zip: '44039',
      coords: COORDS,
    })

    expect(row).not.toBeNull()
    expect(row.url).toBe('https://www.openstreetmap.org/node/123456789')
    expect(row.source).toBe('osm_overpass')
    expect(row.source_id).toBe('node:123456789')
    expect(row.state).toBe('OH')
  })

  it('maps way and relation elements too (all three Overpass element types)', () => {
    for (const type of ['way', 'relation']) {
      const row = mapOsmElementToOpportunity({
        element: { type, id: 42, tags: { name: 'Local Shelter', amenity: 'shelter' } },
        zip: '44039',
        coords: COORDS,
      })
      expect(row, `${type} element must map`).not.toBeNull()
      expect(row.url).toBe(`https://www.openstreetmap.org/${type}/42`)
    }
  })

  it('still refuses an element with a non-numeric or missing id (no fabricated URL)', () => {
    expect(
      mapOsmElementToOpportunity({
        element: { type: 'node', id: 'abc', tags: { name: 'Bogus' } },
        zip: '44039',
        coords: COORDS,
      }),
    ).toBeNull()

    expect(
      mapOsmElementToOpportunity({
        element: { type: 'node', tags: { name: 'No Id' } },
        zip: '44039',
        coords: COORDS,
      }),
    ).toBeNull()

    // An unknown element type is refused even with a valid id.
    expect(
      mapOsmElementToOpportunity({
        element: { type: 'changeset', id: 7, tags: { name: 'Wrong Type' } },
        zip: '44039',
        coords: COORDS,
      }),
    ).toBeNull()
  })
})
