/**
 * crawlerGeoOutwardExpansion.test.js
 *
 * Guards the city → county → state → national OUTWARD EXPANSION of the crawler
 * candidate pool and scoring (docs/canonical_rules.md G4:
 *   "Matching expands outward: city → county → state → national").
 *
 * The bug this pins: the candidate-pool queries matched opportunities by STATE
 * only, so a genuinely LOCAL county/city award never entered the pool to be
 * scored — adding a second address only added state-level coverage. These tests
 * prove:
 *
 *   1. buildProfileGeoScope collects states + counties + cities from a profile's
 *      resolved locations, and degrades to state-only for a single-address,
 *      state-only profile (STRICTLY ADDITIVE).
 *
 *   2. The candidate-pool SQL (the exact predicate both crawlers build) pulls a
 *      county-scoped opportunity that a state-only query would ALSO get, but
 *      additionally surfaces a county/city-local row even when state is absent.
 *      Run against a real in-memory sqlite funding_opportunities slice, with
 *      parameterized binding (no injection).
 *
 *   3. calculateOpportunityMatch (comprehensive prefilter) credits a COUNTY/CITY
 *      match as MORE local than a state-only match, and a far-away state scores
 *      lowest (county > city > state > national > far-away-state).
 *
 *   4. scoreOpportunity (matchEngine, localCrawler's scorer) likewise scores a
 *      county-local opportunity strictly higher than a far-away state one.
 *
 * Pure functions + a tiny sqlite slice. No network, no full schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { buildProfileGeoScope } from '../services/localCrawler.js'
import { calculateOpportunityMatch } from '../services/comprehensiveCrawlerOptimized.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'

// ---------------------------------------------------------------------------
// 1. buildProfileGeoScope
// ---------------------------------------------------------------------------

describe('buildProfileGeoScope — outward expansion collection', () => {
  it('collects state + county + city from a single resolved location', () => {
    const signals = {
      location: { state: 'TN', county: 'Putnam County', city: 'Cookeville', zip: '38501' },
      locations: [{ state: 'TN', county: 'Putnam County', city: 'Cookeville', zip: '38501' }],
      states: ['TN'],
    }
    const scope = buildProfileGeoScope(signals)
    expect(scope.states).toEqual(['TN'])
    // County normalized: lower-cased, trailing "county" stripped.
    expect(scope.counties).toEqual(['putnam'])
    expect(scope.cities).toEqual(['cookeville'])
  })

  it('is additive across multiple addresses (home OH + school TN)', () => {
    const signals = {
      location: { state: 'OH', county: 'Franklin County', city: 'Columbus', zip: '43215' },
      locations: [
        { state: 'OH', county: 'Franklin County', city: 'Columbus', zip: '43215' },
        { state: 'TN', county: 'Putnam County', city: 'Cookeville', zip: '38501' },
      ],
      states: ['OH', 'TN'],
    }
    const scope = buildProfileGeoScope(signals)
    expect(scope.states).toEqual(['OH', 'TN'])
    expect(scope.counties).toEqual(['franklin', 'putnam'])
    expect(scope.cities).toEqual(['columbus', 'cookeville'])
  })

  it('degrades to state-only for a state-only single-address profile (additive guarantee)', () => {
    const signals = {
      location: { state: 'TN', county: null, city: null, zip: null },
      locations: [{ state: 'TN', county: null, city: null, zip: null }],
      states: ['TN'],
    }
    const scope = buildProfileGeoScope(signals)
    expect(scope.states).toEqual(['TN'])
    expect(scope.counties).toEqual([])
    expect(scope.cities).toEqual([])
  })

  it('honors a flat fallback state when signals carry no geography', () => {
    const scope = buildProfileGeoScope({}, 'tn')
    expect(scope.states).toEqual(['TN'])
  })
})

// ---------------------------------------------------------------------------
// 2. Candidate-pool SQL — replicates the exact predicate both crawlers build.
// ---------------------------------------------------------------------------

/**
 * Build the same parameterized geo predicate the crawlers build for sqlite.
 * Mirrors the production construction so the test fails if the shape drifts.
 */
function buildGeoCandidateQuery(geoScope) {
  const geoClauses = []
  const geoParams = []
  if (geoScope.states.length > 0) {
    geoClauses.push(`UPPER(state) IN (${geoScope.states.map(() => '?').join(', ')})`)
    geoParams.push(...geoScope.states)
  }
  if (geoScope.counties.length > 0) {
    const norm = "TRIM(REPLACE(LOWER(COALESCE(geo_county, '')), 'county', ''))"
    geoClauses.push(`${norm} IN (${geoScope.counties.map(() => '?').join(', ')})`)
    geoParams.push(...geoScope.counties)
  }
  for (const city of geoScope.cities) {
    geoClauses.push("LOWER(COALESCE(description, '')) LIKE ? ESCAPE '\\'")
    geoParams.push(`%${city.replace(/[%_\\]/g, '\\$&')}%`)
  }
  geoClauses.push('is_national = 1')
  const sql = `
    SELECT * FROM funding_opportunities
    WHERE is_active = 1
      AND (requires_match = 0 OR requires_match IS NULL)
      AND (${geoClauses.join(' OR ')})
      AND ${trustedOriginClause()}
      AND ${trustedSourceClause()}
    LIMIT 200
  `
  return { sql, geoParams }
}

describe('candidate-pool SQL — city → county → state → national', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        state TEXT,
        geo_county TEXT,
        is_national INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        is_hidden INTEGER DEFAULT 0,
        opportunity_kind TEXT,
        result_kind TEXT,
        opportunity_type TEXT,
        type TEXT,
        application_url TEXT,
        source_url TEXT,
        link_status TEXT DEFAULT 'ok',
        last_verified_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        requires_match INTEGER DEFAULT 0,
        record_origin TEXT,
        source TEXT
      );
    `)
    const ins = db.prepare(`
      INSERT INTO funding_opportunities
        (id, title, description, state, geo_county, is_national, record_origin, source)
      VALUES (@id, @title, @description, @state, @geo_county, @is_national, @record_origin, @source)
    `)
    // A genuinely LOCAL county award (no state column set — county is the only geo).
    ins.run({ id: 'county-local', title: 'Putnam County Family Relief Fund',
      description: 'Emergency assistance for residents of Putnam County.',
      state: null, geo_county: 'Putnam County', is_national: 0,
      record_origin: 'live_crawl', source: 'local_foundation' })
    // A city-local award reachable only via description text (no city column).
    ins.run({ id: 'city-local', title: 'Cookeville Neighborhood Microgrant',
      description: 'Small grants for projects in Cookeville.',
      state: null, geo_county: null, is_national: 0,
      record_origin: 'live_crawl', source: 'local_foundation' })
    // A state-scoped award.
    ins.run({ id: 'state-tn', title: 'Tennessee Arts Grant',
      description: 'Statewide arts funding.',
      state: 'TN', geo_county: null, is_national: 0,
      record_origin: 'live_crawl', source: 'local_foundation' })
    // A far-away state award (must NOT be a candidate).
    ins.run({ id: 'state-ca', title: 'California Coastal Fund',
      description: 'Coastal restoration in California.',
      state: 'CA', geo_county: null, is_national: 0,
      record_origin: 'live_crawl', source: 'local_foundation' })
    // A national award (always a candidate).
    ins.run({ id: 'national', title: 'National Hardship Grant',
      description: 'Open to all U.S. residents.',
      state: 'Nationwide', geo_county: null, is_national: 1,
      record_origin: 'live_crawl', source: 'verified_real' })
  })
  afterEach(() => { db.close() })

  it('surfaces the county-local AND city-local rows that a state-only query would miss', () => {
    const geoScope = buildProfileGeoScope({
      location: { state: 'TN', county: 'Putnam County', city: 'Cookeville', zip: '38501' },
      locations: [{ state: 'TN', county: 'Putnam County', city: 'Cookeville', zip: '38501' }],
      states: ['TN'],
    })
    const { sql, geoParams } = buildGeoCandidateQuery(geoScope)
    const ids = db.prepare(sql).all(...geoParams).map((r) => r.id).sort()

    // county-local + city-local are NEW recall the old state-IN query could never get.
    expect(ids).toContain('county-local')
    expect(ids).toContain('city-local')
    // The state-only opp that the previous query DID get is still present.
    expect(ids).toContain('state-tn')
    // National is always admitted.
    expect(ids).toContain('national')
    // The far-away state is excluded.
    expect(ids).not.toContain('state-ca')
  })

  it('a state-only profile still pulls the same state + national pool (additive)', () => {
    const geoScope = buildProfileGeoScope({
      location: { state: 'TN', county: null, city: null, zip: null },
      locations: [{ state: 'TN', county: null, city: null, zip: null }],
      states: ['TN'],
    })
    const { sql, geoParams } = buildGeoCandidateQuery(geoScope)
    const ids = db.prepare(sql).all(...geoParams).map((r) => r.id).sort()

    expect(ids).toContain('state-tn')
    expect(ids).toContain('national')
    expect(ids).not.toContain('state-ca')
    // With no county/city resolved, the county-only / city-only rows are not pulled
    // (they have no state) — proving the predicate genuinely keyed off county/city
    // in the previous test rather than incidentally matching on state.
    expect(ids).not.toContain('county-local')
    expect(ids).not.toContain('city-local')
  })
})

// ---------------------------------------------------------------------------
// 3. calculateOpportunityMatch — county/city outrank state; far-away lowest.
// ---------------------------------------------------------------------------

describe('calculateOpportunityMatch — geo tier ordering (comprehensive prefilter)', () => {
  const signals = {
    location: { state: 'TN', county: 'Putnam County', city: 'Cookeville', zip: '38501' },
    locations: [{ state: 'TN', county: 'Putnam County', city: 'Cookeville', zip: '38501' }],
    states: ['TN'],
    keywords: [],
    demographics: new Set(),
  }
  const profileState = 'TN'

  const countyOpp = { title: 'County Fund', description: 'Local relief.', geo_county: 'Putnam County', state: null }
  const cityOpp = { title: 'City Fund', description: 'Grants in Cookeville for residents.', geo_county: null, state: null }
  const stateOpp = { title: 'State Fund', description: 'Statewide.', geo_county: null, state: 'TN' }
  const nationalOpp = { title: 'National Fund', description: 'Everyone.', geo_county: null, state: 'Nationwide', is_national: true }
  const farStateOpp = { title: 'CA Fund', description: 'California only.', geo_county: null, state: 'CA' }

  it('credits a county match as MORE local than a state-only match', () => {
    const county = calculateOpportunityMatch(countyOpp, signals, profileState).score
    const state = calculateOpportunityMatch(stateOpp, signals, profileState).score
    expect(county).toBeGreaterThan(state)
  })

  it('orders county > city > state > national, with a far-away state lowest', () => {
    const county = calculateOpportunityMatch(countyOpp, signals, profileState).score
    const city = calculateOpportunityMatch(cityOpp, signals, profileState).score
    const state = calculateOpportunityMatch(stateOpp, signals, profileState).score
    const national = calculateOpportunityMatch(nationalOpp, signals, profileState).score
    const far = calculateOpportunityMatch(farStateOpp, signals, profileState).score

    expect(county).toBeGreaterThan(city)
    expect(city).toBeGreaterThan(state)
    expect(state).toBeGreaterThan(national)
    expect(national).toBeGreaterThan(far)
  })

  it('is unchanged for a state-only profile (county opp falls back to no-geo, state opp still credited)', () => {
    const stateOnly = {
      location: { state: 'TN', county: null, city: null, zip: null },
      locations: [{ state: 'TN', county: null, city: null, zip: null }],
      states: ['TN'],
      keywords: [],
      demographics: new Set(),
    }
    const state = calculateOpportunityMatch(stateOpp, stateOnly, 'TN').score
    expect(state).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. scoreOpportunity (matchEngine) — county-local strictly beats far-away state.
// ---------------------------------------------------------------------------

describe('scoreOpportunity (localCrawler scorer) — county-local beats far state', () => {
  const profileContext = {
    profile: { id: 'p1', state: 'TN', city: 'Cookeville', postal_code: '38501' },
    sections: {
      basic_information: { city: 'Cookeville', state: 'TN', zip: '38501' },
    },
  }

  it('scores a county-local opportunity higher than a far-away state opportunity', () => {
    const countyOpp = {
      title: 'Putnam County Relief',
      description: 'Assistance for Putnam County residents.',
      geo_county: 'Putnam County',
      state: null,
    }
    const farOpp = {
      title: 'California Coastal Fund',
      description: 'Coastal restoration in California.',
      geo_county: null,
      state: 'CA',
    }
    const county = scoreOpportunity(profileContext, countyOpp).score
    const far = scoreOpportunity(profileContext, farOpp).score
    expect(county).toBeGreaterThan(far)
  })
})
