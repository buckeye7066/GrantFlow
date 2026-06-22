/**
 * Tests for two discovery fixes:
 *
 *  1. Honest degradation — summarizeDiscoveryDegradation() turns a Crawler-OS
 *     run summary into a clear status reason when the run produced nothing for a
 *     CONFIG reason (every source skipped for missing env, no source selected,
 *     all fetches failed) so the dashboard shows WHY a run was empty instead of
 *     a healthy-looking green empty run. It returns null for a genuine
 *     "no funding matched this profile" so we don't cry wolf.
 *
 *  2. Dry-run preview — runProfileDiscoveryLive({ dryRun:true }) runs the REAL
 *     pipeline against an in-memory store but does NOT flush anything to the live
 *     funding_opportunities / matches tables, returning a count preview. A live
 *     run DOES persist. This makes a Mission Control / Anya dry-run an honest
 *     read-only preview instead of a misleading 0/0/0.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

import { summarizeDiscoveryDegradation } from '../services/robert/robertAgent.js'
import { runProfileDiscoveryLive } from '../services/crawlerOsService.js'

// --- 1. summarizeDiscoveryDegradation (pure) -------------------------------

describe('summarizeDiscoveryDegradation', () => {
  it('returns null when discovery stored opportunities (not degraded)', () => {
    const summary = { matched: [{ stored: 3, sources: [{ source_id: 'grants_gov', outcome: 'ok', fetched: 4 }] }] }
    expect(summarizeDiscoveryDegradation(summary)).toBeNull()
  })

  it('flags discovery_provider_not_configured when every source skipped for missing env', () => {
    const summary = {
      matched: [{
        stored: 0,
        sources: [
          { source_id: 'sam_gov', outcome: 'skipped', reason: 'missing_env:SAM_GOV_API_KEY', fetched: 0 },
        ],
      }],
    }
    const d = summarizeDiscoveryDegradation(summary)
    expect(d?.reason).toBe('discovery_provider_not_configured')
    expect(d.detail).toContain('SAM_GOV_API_KEY')
  })

  it('flags all_sources_skipped when sources skipped with no adapter (not env)', () => {
    const summary = {
      matched: [{ stored: 0, sources: [{ source_id: 'cof_locator', outcome: 'skipped', reason: 'no_adapter', fetched: 0 }] }],
    }
    expect(summarizeDiscoveryDegradation(summary)?.reason).toBe('all_sources_skipped')
  })

  it('flags all_fetches_failed when sources ran but nothing fetched', () => {
    const summary = {
      matched: [{ stored: 0, sources: [{ source_id: 'grants_gov', outcome: 'fetch_error', reason: 'fetch_failed', fetched: 0 }] }],
    }
    expect(summarizeDiscoveryDegradation(summary)?.reason).toBe('all_fetches_failed')
  })

  it('returns null for an HONEST empty (sources fetched, nothing cleared the floor)', () => {
    const summary = {
      matched: [{ stored: 0, sources: [{ source_id: 'grants_gov', outcome: 'empty', reason: 'no_candidates_stored', fetched: 4 }] }],
    }
    // Not a misconfiguration — a real "no funding matched". Do NOT raise a reason.
    expect(summarizeDiscoveryDegradation(summary)).toBeNull()
  })

  it('flags no_sources_selected when planner picked nothing', () => {
    const summary = { matched: [{ stored: 0, sources: [] }] }
    expect(summarizeDiscoveryDegradation(summary)?.reason).toBe('no_sources_selected')
  })
})

// --- 2. dry-run preview vs live persistence --------------------------------

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
  // Minimal async-shim: better-sqlite3 is sync; awaiting a non-promise yields it.
  raw.dialect = 'sqlite'
  return raw
}

// One grants.gov-shaped opportunity that clears the reality gate + floor.
const GRANTS_GOV_BODY = JSON.stringify({
  data: {
    oppHits: [{
      id: '900001',
      number: 'TEST-900001',
      title: 'Rural Community Facilities Grant',
      synopsis: 'Funding for rural community facilities and equipment across the United States.',
      agency: 'U.S. Department of Test',
      agencyCode: 'TEST',
      closeDate: '12/31/2099',
      openDate: '01/01/2026',
      oppStatus: 'posted',
    }],
  },
})

// Stub OS fetcher: returns the grants.gov body for the search endpoint, an empty
// 200 for everything else (so other registry sources parse to nothing).
function makeStubFetcher() {
  return {
    async fetch(url) {
      const isGrantsSearch = String(url).includes('api.grants.gov')
      const body = isGrantsSearch ? GRANTS_GOV_BODY : '{}'
      return {
        ok: true, status: 200, finalUrl: url,
        contentHash: 'hash', body, fetchedAt: new Date().toISOString(),
      }
    },
  }
}

function seedProfile(db) {
  db.prepare(
    `INSERT INTO profiles (id, primary_type, applicant_type, state, county, city, tags)
     VALUES ('p-os-1', 'nonprofit', 'nonprofit', 'TN', 'Bradley', 'Cleveland', '["community"]')`,
  ).run()
}

describe('runProfileDiscoveryLive dry-run preview vs live persistence', () => {
  it('LIVE run persists discovered opportunities into funding_opportunities', async () => {
    const db = makeDb()
    seedProfile(db)
    const { persisted } = await runProfileDiscoveryLive({
      db, profileId: 'p-os-1', fetcher: makeStubFetcher(),
    })
    const count = db.prepare('SELECT COUNT(*) AS c FROM funding_opportunities').get().c
    expect(count).toBeGreaterThan(0)
    expect(persisted.opportunities).toBeGreaterThan(0)
  })

  it('DRY-RUN previews counts but writes NOTHING to the live tables', async () => {
    const db = makeDb()
    seedProfile(db)
    const { persisted } = await runProfileDiscoveryLive({
      db, profileId: 'p-os-1', fetcher: makeStubFetcher(), dryRun: true,
    })
    // Preview reports what WOULD be stored…
    expect(persisted.dry_run).toBe(true)
    expect(persisted.opportunities).toBeGreaterThan(0)
    // …but the live catalog is untouched.
    const count = db.prepare('SELECT COUNT(*) AS c FROM funding_opportunities').get().c
    expect(count).toBe(0)
    // The matches table is only created by the live persistence path
    // (ensureOsTables). A dry-run must never have created it nor written rows.
    let matchCount = 0
    try {
      matchCount = db.prepare('SELECT COUNT(*) AS c FROM profile_opportunity_matches').get().c
    } catch { /* table does not exist => dry-run never persisted; that's correct */ }
    expect(matchCount).toBe(0)
  })
})
