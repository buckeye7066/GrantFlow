/**
 * Robert charter: "match every newly stored opportunity against ALL known
 * profiles". runProfileDiscoveryLive, given matchProfiles = multiple theses,
 * matches each discovered opp against all of them: the DISCOVERING profile is
 * PRIMARY (authoritative 'crawler-os'), every OTHER eligible profile gets an
 * additive 'crawler-os-xmatch' row (ON CONFLICT DO NOTHING — its own match
 * always wins; the primary reconcile never wipes it). A single-profile call is
 * unchanged (no xmatch).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { runProfileDiscoveryLive, buildThesisForProfile } from '../services/crawlerOsService.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, organization_id TEXT, display_name TEXT,
      primary_type TEXT, applicant_type TEXT, state TEXT, county TEXT,
      city TEXT, postal_code TEXT, zip_code TEXT, tags TEXT, interests TEXT,
      status TEXT DEFAULT 'active', last_discovery_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, state TEXT, city TEXT, mission TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, extracted_text TEXT, summary TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, sponsor TEXT, description TEXT,
      source TEXT, source_id TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,
      deadline TEXT, amount_min REAL, amount_max REAL, is_loan INTEGER, requires_match INTEGER,
      is_national INTEGER, state TEXT, categories TEXT, opportunity_kind TEXT,
      source_trust_tier TEXT, reality_status TEXT, record_origin TEXT, fingerprint TEXT,
      evidence_url TEXT, is_active INTEGER DEFAULT 1, is_hidden INTEGER DEFAULT 0,
      last_crawled DATETIME, last_verified_at DATETIME, discovered_at DATETIME, updated_at DATETIME
    );
    CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, status TEXT);
  `)
  raw.dialect = 'sqlite'
  return raw
}

const GRANTS_GOV_BODY = JSON.stringify({
  data: {
    oppHits: [{
      id: '900001', number: 'TEST-900001',
      title: 'Rural Community Facilities Grant',
      synopsis: 'Funding for rural community facilities and equipment for nonprofits across the United States.',
      agency: 'U.S. Department of Test', agencyCode: 'TEST',
      closeDate: '12/31/2099', openDate: '01/01/2026', oppStatus: 'posted',
    }],
  },
})

function makeStubFetcher() {
  return {
    async fetch(url) {
      const body = String(url).includes('api.grants.gov') ? GRANTS_GOV_BODY : '{}'
      return { ok: true, status: 200, finalUrl: url, contentHash: 'hash', body, fetchedAt: new Date().toISOString() }
    },
  }
}

function seedTwoNonprofits(db) {
  for (const id of ['p-a', 'p-b']) {
    db.prepare(
      `INSERT INTO profiles (id, primary_type, applicant_type, state, county, city, tags)
       VALUES (?, 'nonprofit', 'nonprofit', 'TN', 'Bradley', 'Cleveland', '["community"]')`,
    ).run(id)
  }
}

describe('cross-profile matching (Robert charter)', () => {
  it('matches a discovered opp against ALL passed profiles: primary=crawler-os, others=crawler-os-xmatch', async () => {
    const db = makeDb()
    seedTwoNonprofits(db)
    const thA = await buildThesisForProfile(db, 'p-a')
    const thB = await buildThesisForProfile(db, 'p-b')
    // Discovery runs for p-a, matched against BOTH theses.
    await runProfileDiscoveryLive({ db, profileId: 'p-a', fetcher: makeStubFetcher(), matchProfiles: [thA, thB] })

    const rows = db.prepare(
      `SELECT profile_id, matcher_version FROM profile_opportunity_matches ORDER BY profile_id`,
    ).all()
    const byProfile = Object.fromEntries(rows.map((r) => [r.profile_id, r.matcher_version]))
    // p-a discovered it → authoritative own match.
    expect(byProfile['p-a']).toBe('crawler-os')
    // p-b never searched for it but is an eligible nonprofit → cross-match.
    expect(byProfile['p-b']).toBe('crawler-os-xmatch')
  }, 20000) // live discovery + cold lazy-imports (zipcodes/matchEngine) can exceed the 5s default under load

  it('a single-profile call writes NO cross-matches (back-compat)', async () => {
    const db = makeDb()
    seedTwoNonprofits(db)
    await runProfileDiscoveryLive({ db, profileId: 'p-a', fetcher: makeStubFetcher() })
    const xmatch = db.prepare(
      `SELECT COUNT(*) AS c FROM profile_opportunity_matches WHERE matcher_version = 'crawler-os-xmatch'`,
    ).get().c
    expect(xmatch).toBe(0)
  }, 20000)
})
