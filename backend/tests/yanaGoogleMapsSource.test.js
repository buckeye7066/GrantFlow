/**
 * Integration tests: the Google Maps source feeds Yana's EXISTING prospect
 * pipeline (score → qualify → enrich → persist) — not a parallel path.
 *
 *   1. makeGoogleMapsSource.discover maps places into Yana's prospect shape and
 *      NOOPs (returns []) when unkeyed.
 *   2. discoverProspects runs Maps prospects through the same scorer/enricher and
 *      persists them; a keyed Maps prospect with an enriched email QUALIFIES.
 *   3. With no key, Maps contributes nothing — Yana behaves exactly as today.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  makeGoogleMapsSource,
  mapPlaceToProspect,
  registerProspectSource,
  _resetProspectSources,
} from '../services/yana/yanaProspectSources.js'
import {
  discoverProspects,
  _resetYanaSchemaCache,
} from '../services/yana/yanaLeadDiscovery.js'

function makeDb() {
  return new Database(':memory:')
}

const PLACES = [
  {
    name: 'Helping Hands Foundation',
    website: 'https://helpinghands.org',
    address: '123 Main St, Nashville, TN',
    phone: '(615) 555-0100',
    place_id: 'PLACE_1',
    types: ['non_profit_organization'],
    lat: 36.16,
    lng: -86.78,
    source: 'google_maps',
  },
]

// A search stub that returns the fixture places regardless of query.
function searchPlacesStub() {
  return async () => PLACES
}

// An enricher that "finds" an email for any prospect with a website — mirrors
// the real makeContactEnricher contract used by discoverProspects.
function enricherFor(email) {
  return {
    enabled: true,
    async enrich(prospect) {
      if (!prospect?.website_url) return { ok: false, reason: 'no_homepage_found' }
      return { ok: true, website_url: prospect.website_url, email, excerpt: 'About our community programs.' }
    },
  }
}

beforeEach(() => {
  _resetYanaSchemaCache()
})

describe('mapPlaceToProspect', () => {
  it('maps a place into Yana prospect shape with website + place_id dedup key', () => {
    const p = mapPlaceToProspect(PLACES[0])
    expect(p.organization_name).toBe('Helping Hands Foundation')
    expect(p.website_url).toBe('https://helpinghands.org')
    expect(p.source).toBe('google_maps')
    expect(p.external_id).toBe('PLACE_1')
    expect(p.location).toBe('123 Main St, Nashville, TN')
    expect(p.public_evidence.some((e) => e.type === 'contact' && e.phone)).toBe(true)
  })
})

describe('makeGoogleMapsSource.discover', () => {
  it('NOOPs (returns []) when no key is set', async () => {
    const src = makeGoogleMapsSource({ searchPlaces: searchPlacesStub(), env: {} })
    expect(await src.discover({ limit: 10 })).toEqual([])
  })

  it('returns mapped prospects when keyed', async () => {
    const src = makeGoogleMapsSource({ searchPlaces: searchPlacesStub(), env: { GOOGLE_MAPS_API_KEY: 'KEY' } })
    const out = await src.discover({ limit: 10, queries: ['nonprofit'] })
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('google_maps')
  })
})

describe('discoverProspects with the Google Maps source', () => {
  it('flows keyed Maps prospects through the existing scorer/enricher and persists them', async () => {
    _resetProspectSources()
    registerProspectSource(
      'google_maps',
      makeGoogleMapsSource({ searchPlaces: searchPlacesStub(), env: { GOOGLE_MAPS_API_KEY: 'KEY' } }),
    )

    const db = makeDb()
    const res = await discoverProspects(db, {
      allowLiveWeb: true,
      sources: ['google_maps'],
      enricher: enricherFor('info@helpinghands.org'),
    })

    // The Maps prospect went through the SAME path: discovered, enriched (email
    // found by the shared enricher), and upserted into the shared candidate table.
    expect(res.discovered).toBe(1)
    expect(res.enriched).toBe(1)
    expect(res.by_source.google_maps).toBe(1)

    const row = db.prepare(
      `SELECT * FROM yana_lead_candidates WHERE source = 'google_maps'`,
    ).get()
    expect(row).toBeTruthy()
    expect(row.contact_email).toBe('info@helpinghands.org')
    expect(row.website_url).toBe('https://helpinghands.org')
    expect(row.external_id).toBe('PLACE_1')
    // Same scorer awarded a website + a real contact email → above-zero lead score.
    expect(row.lead_score).toBeGreaterThan(0)

    _resetProspectSources()
  })

  it('qualifies a richer keyed Maps prospect through the shared scorer', async () => {
    _resetProspectSources()
    // A Maps prospect carrying mission/focus signal: the SHARED scorer clears the
    // qualify threshold once enrichment supplies an email — proving Maps prospects
    // reach `qualified` through the existing path, not a parallel scorer.
    const richEnricher = {
      enabled: true,
      async enrich(prospect) {
        return {
          ok: true,
          website_url: prospect.website_url,
          email: 'info@helpinghands.org',
          excerpt: 'We deliver education and housing programs to local families.',
        }
      },
    }
    registerProspectSource('google_maps', {
      name: 'google_maps',
      async discover() {
        return [{
          source: 'google_maps',
          external_id: 'PLACE_RICH',
          organization_name: 'Helping Hands Foundation',
          organization_type: 'nonprofit',
          entity_type: 'nonprofit',
          location: 'Nashville, TN',
          mission: 'We deliver education and housing programs to local families in need.',
          focus_areas: ['education', 'housing'],
          program_areas: ['after-school'],
          website: 'https://helpinghands.org',
          website_url: 'https://helpinghands.org',
          email: null,
          source_urls: ['https://helpinghands.org'],
          public_evidence: [{ type: 'address', text: '123 Main St, Nashville, TN' }],
        }]
      },
    })

    const db = makeDb()
    const res = await discoverProspects(db, {
      allowLiveWeb: true,
      sources: ['google_maps'],
      enricher: richEnricher,
    })

    expect(res.qualified).toBe(1)
    const row = db.prepare(`SELECT * FROM yana_lead_candidates WHERE source = 'google_maps'`).get()
    expect(row.qualification_status).toBe('qualified')
    expect(row.contact_email).toBe('info@helpinghands.org')

    _resetProspectSources()
  })

  it('contributes nothing when the Maps source is unkeyed (Yana unchanged)', async () => {
    _resetProspectSources()
    const searchSpy = vi.fn(async () => PLACES)
    registerProspectSource('google_maps', makeGoogleMapsSource({ searchPlaces: searchSpy, env: {} }))

    const db = makeDb()
    const res = await discoverProspects(db, {
      allowLiveWeb: true,
      sources: ['google_maps'],
      enricher: enricherFor('info@helpinghands.org'),
    })

    expect(res.discovered).toBe(0)
    expect(searchSpy).not.toHaveBeenCalled() // unkeyed → no network attempt
    const count = db.prepare(`SELECT COUNT(*) AS c FROM yana_lead_candidates`).get().c
    expect(count).toBe(0)

    _resetProspectSources()
  })
})
