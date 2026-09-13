/**
 * Robert charter: "match every newly stored opportunity against ALL known
 * profiles". runProfileDiscoveryLive, given matchProfiles = multiple theses,
 * matches each discovered opp against all of them: the DISCOVERING profile is
 * PRIMARY (authoritative 'crawler-os'), every OTHER engine-ACCEPTED profile gets
 * an additive 'crawler-os-xmatch' row (ON CONFLICT DO NOTHING — its own match
 * always wins; the primary reconcile never wipes it). REVIEW is deliberately
 * not cross-persisted because a context-light cross-profile thesis cannot prove
 * eligibility. A single-profile call is unchanged (no xmatch).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { runProfileDiscoveryLive, buildThesisForProfile } from '../services/crawlerOsService.js'
import { computeMatchDecision } from '../crawler-os/matchEngine.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, organization_id TEXT, display_name TEXT,
      primary_type TEXT, applicant_type TEXT, state TEXT, county TEXT,
      city TEXT, postal_code TEXT, zip_code TEXT, tags TEXT, interests TEXT,
      needs TEXT,
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
      eligibility_bullets TEXT, field_provenance TEXT,
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

const GRANTS_GOV_DETAIL_BODY = JSON.stringify({
  errorcode: 0,
  data: {
    id: 900001, opportunityNumber: 'TEST-900001',
    opportunityTitle: 'Rural Community Facilities Grant',
    synopsis: {
      opportunityId: 900001,
      synopsisDesc: 'Funding for rural community facilities and equipment for nonprofits across the United States.',
      applicantTypes: [
        { id: '12', description: 'Nonprofits having 501(c)(3) status' },
        { id: '13', description: 'Nonprofits without 501(c)(3) status' },
      ],
      costSharing: 'No', responseDateStr: '2099-12-31',
    },
  },
})

function makeStubFetcher() {
  return {
    async fetch(url) {
      const body = String(url).endsWith('/fetchOpportunity') ? GRANTS_GOV_DETAIL_BODY
        : String(url).includes('api.grants.gov') ? GRANTS_GOV_BODY : '{}'
      return { ok: true, status: 200, finalUrl: url, contentHash: 'hash', body, fetchedAt: '2026-09-08T00:00:00.000Z' }
    },
  }
}

function seedTwoNonprofits(db, {
  pANeeds = ['equipment', 'capital'],
  pBNeeds = ['equipment', 'capital'],
} = {}) {
  for (const id of ['p-a', 'p-b']) {
    db.prepare(
      `INSERT INTO profiles (id, primary_type, applicant_type, state, county, city, tags, needs)
       VALUES (?, 'nonprofit', 'nonprofit', 'TN', 'Bradley', 'Cleveland', '["community"]', ?)`,
    ).run(id, JSON.stringify(id === 'p-a' ? pANeeds : pBNeeds))
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
      `SELECT m.profile_id, m.matcher_version, m.match_decision
         FROM profile_opportunity_matches m
         JOIN funding_opportunities fo ON fo.id = m.opportunity_id
        WHERE fo.title = 'Rural Community Facilities Grant'
        ORDER BY m.profile_id`,
    ).all()
    const byProfile = Object.fromEntries(rows.map((r) => [r.profile_id, r]))
    // p-a discovered it → authoritative own match.
    expect(byProfile['p-a']?.matcher_version).toBe('crawler-os')
    // p-b explicitly needs both equipment and capital; the canonical matcher
    // ACCEPTs this direct, national nonprofit grant, so cross-persistence is
    // warranted under the ACCEPT-only precision policy.
    expect(byProfile['p-b']).toMatchObject({
      matcher_version: 'crawler-os-xmatch',
      match_decision: 'accept',
    })
  }, 20000) // live discovery + cold lazy-imports (zipcodes/matchEngine) can exceed the 5s default under load

  it('does not cross-persist a REVIEW scored from a context-light thesis', async () => {
    const db = makeDb()
    // p-b declares needs the facilities grant does not serve. (Until
    // 2026-09-12 this fixture carried 'capital' + 'capacity_building' too and
    // read as REVIEW only because the thesis derivation DROPPED declared
    // canonical needs; with declared needs surviving verbatim the engine
    // rightly ACCEPTs a capital/facilities grant for a profile that declares
    // a capital need, so that fixture no longer exercises the REVIEW case.)
    seedTwoNonprofits(db, {
      pBNeeds: ['operations', 'programs'],
    })
    const thA = await buildThesisForProfile(db, 'p-a')
    const thB = await buildThesisForProfile(db, 'p-b')

    const res = await runProfileDiscoveryLive({ db, profileId: 'p-a', fetcher: makeStubFetcher(), matchProfiles: [thA, thB] })

    // Teeth: the engine's own verdict for p-b is REVIEW (not REJECT), so an
    // absent xmatch row proves the ACCEPT-only precision policy, not a reject.
    const opp = (res.opportunities || []).find((o) => /Rural Community Facilities/.test(o.title))
    expect(opp).toBeTruthy()
    expect(computeMatchDecision(opp, thB).decision).toBe('review')

    const targetRows = db.prepare(
      `SELECT m.profile_id, m.matcher_version
         FROM profile_opportunity_matches m
         JOIN funding_opportunities fo ON fo.id = m.opportunity_id
        WHERE fo.title = 'Rural Community Facilities Grant'
        ORDER BY m.profile_id`,
    ).all()

    expect(targetRows).toEqual([
      expect.objectContaining({ profile_id: 'p-a', matcher_version: 'crawler-os' }),
    ])
  }, 20000)

  it('keeps the full primary profile when fleet theses omit it or contain duplicate stale stubs', async () => {
    const db = makeDb()
    seedTwoNonprofits(db)
    db.prepare('INSERT INTO profile_sections VALUES (?, ?, ?)').run('p-a', 'basic_information', JSON.stringify({ mission: 'Rural equipment and community facilities', state: 'TN', city: 'Cleveland' }))
    const own = await runProfileDiscoveryLive({ db, profileId: 'p-a', fetcher: makeStubFetcher(), dryRun: true })
    expect(own.run.recommendations.length + own.run.research_leads.length).toBeGreaterThan(0)
    const stale = await buildThesisForProfile(db, 'p-a')
    const other = await buildThesisForProfile(db, 'p-b')
    const primaryMatches = (result) => [...result.run.recommendations, ...result.run.research_leads]
    for (const profiles of [[other], [stale, stale, other, other]]) {
      const fleet = await runProfileDiscoveryLive({ db, profileId: 'p-a', fetcher: makeStubFetcher(), matchProfiles: profiles, dryRun: true })
      expect(fleet.persisted.matches).toBeGreaterThan(0)
      expect(primaryMatches(fleet)).toEqual(primaryMatches(own))
      expect(fleet.persisted.matches).toBe(own.persisted.matches * 2)
    }
    db.close()
  }, 20000)

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
