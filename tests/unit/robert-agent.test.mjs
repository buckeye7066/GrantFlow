import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { makeMemoryDb } from './robert-test-helpers.mjs'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'
import { runRobert, getRobertStatus, resolveProfileIds } from '../../backend/services/robert/robertAgent.js'
import { latestRun } from '../../backend/services/robert/robertRunStore.js'

let db
beforeEach(() => {
  db = makeMemoryDb()
  // reset env between tests
  delete process.env.ROBERT_ENABLED
  delete process.env.ROBERT_ALLOW_LIVE_WEB
  delete process.env.ROBERT_ALLOW_SOURCE_DISCOVERY
  delete process.env.ROBERT_AUTO_INGEST_VERIFIED
  delete process.env.ROBERT_MODE
})

const PROFILE_CTX = {
  profile: { id: 'p1', display_name: 'Family', primary_type: 'family', state: 'OH', tags: ['housing'] },
  sections: { location_focus: { state: 'OH', county: 'Cuyahoga', city: 'Cleveland' } },
  signals: { entityType: 'family', state: 'OH' },
}

function crawlerOsReceipt() {
  return {
    run: {
      stored: 0,
      rejected: 0,
      cross_matches: 0,
      recommendations: [],
      sources: [{ source_id: 'fixture', outcome: 'ok', fetched: 1, parsed: 0, stored: 0, deduped: 0 }],
    },
    persisted: { opportunities: 0, matches: 0 },
    thesis: { applicant_types: ['individual'] },
  }
}

describe('robertAgent — defaults are safe', () => {
  it('is disabled by default; observe runs from manual trigger persist a run', async () => {
    const result = await runRobert({
      db,
      mode: 'observe',
      trigger: 'manual',
      profileIds: ['p1'],
      deps: {
        loadProfileContext: async () => PROFILE_CTX,
        listActiveProfileIds: async () => ['p1'],
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'observe')
    assert.equal(result.status, 'completed')
    const last = await latestRun(db)
    assert.ok(last)
    assert.equal(last.mode, 'observe')
  })

  it('downgrades discover-sources to observe when live web is OFF', async () => {
    const result = await runRobert({
      db,
      mode: 'discover-sources',
      trigger: 'manual',
      profileIds: ['p1'],
      deps: {
        loadProfileContext: async () => PROFILE_CTX,
        searchProvider: async () => [{ url: 'https://example.com/x', title: 'x' }],
      },
    })
    assert.equal(result.mode, 'observe', 'must be downgraded to observe when live web is disabled')
  })

  it('respects max_profiles_per_run', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `p${i}`)
    const result = await runRobert({
      db,
      mode: 'observe',
      trigger: 'manual',
      profileIds: ids,
      deps: {
        loadProfileContext: async (_d, id) => ({ ...PROFILE_CTX, profile: { ...PROFILE_CTX.profile, id } }),
        configOverride: { maxProfilesPerRun: 5 },
      },
    })
    assert.equal(result.counters.profiles_considered, 5)
  })

  it('rotates bounded live discovery toward never and least-recently crawled profiles', async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        status TEXT,
        updated_at TEXT
      );
      CREATE TABLE crawler_runs (
        run_id TEXT PRIMARY KEY,
        profile_id TEXT,
        started_at TEXT
      );
      INSERT INTO profiles (id, status, updated_at) VALUES
        ('p-never', 'active', '2026-09-01T00:00:00.000Z'),
        ('p-old', 'active', '2026-08-01T00:00:00.000Z'),
        ('p-recent', 'active', '2026-07-01T00:00:00.000Z'),
        ('p-deleted', 'deleted', '2026-09-02T00:00:00.000Z');
      INSERT INTO crawler_runs (run_id, profile_id, started_at) VALUES
        ('run-old', 'p-old', '2026-07-01T00:00:00.000Z'),
        ('run-recent', 'p-recent', '2026-09-01T00:00:00.000Z');
    `)

    const selected = await resolveProfileIds({
      db: wrapSqlite(sqlite),
      cap: 2,
      deps: {},
    })

    assert.deepEqual(selected, ['p-never', 'p-old'])
    sqlite.close()
  })

  it('does NOT ingest opportunities when autoIngestVerified is false', async () => {
    process.env.ROBERT_ENABLED = 'true'
    process.env.ROBERT_ALLOW_LIVE_WEB = 'true'
    process.env.ROBERT_ALLOW_SOURCE_DISCOVERY = 'true'
    let upsertCalled = 0
    const result = await runRobert({
      db,
      mode: 'discover-opportunities',
      trigger: 'manual',
      profileIds: ['p1'],
      deps: {
        loadProfileContext: async () => PROFILE_CTX,
        searchProvider: async () => [{ url: 'https://www.fema.gov/grants/x', title: 'FEMA grant page' }],
        opportunityAdapter: async () => ([
          { title: 'Real Grant', sponsor: 'FEMA', application_url: 'https://www.fema.gov/apply', source_url: 'https://www.fema.gov/x', deadline: '2099-09-01', deadline_type: 'fixed' },
        ]),
        upsertFundingOpportunity: async () => { upsertCalled += 1; return { id: 'opp', inserted: true } },
        runProfileDiscoveryLive: async () => crawlerOsReceipt(),
      },
    })
    assert.equal(upsertCalled, 0, 'upsert must NOT be called without autoIngestVerified')
    assert.ok(result.ok)
  })

  it('does not invoke the retired placeholder adapter or legacy writer after Crawler OS cutover', async () => {
    process.env.ROBERT_ENABLED = 'true'
    process.env.ROBERT_ALLOW_LIVE_WEB = 'true'
    process.env.ROBERT_AUTO_INGEST_VERIFIED = 'true'
    let upsertCalled = 0
    let legacyAdapterCalled = 0
    const result = await runRobert({
      db,
      mode: 'full-cycle',
      trigger: 'manual',
      profileIds: ['p1'],
      deps: {
        loadProfileContext: async () => PROFILE_CTX,
        opportunityAdapter: async () => {
          legacyAdapterCalled += 1
          return [{ title: 'Test Grant', sponsor: 'Test', application_url: 'https://example.com/x', source_url: 'https://example.com/x' }]
        },
        seedSources: [{ id: 's1', source_url: 'https://www.fema.gov/grants', source_type: 'fire_department_grants' }],
        upsertFundingOpportunity: async () => { upsertCalled += 1; return { id: 'opp', inserted: true } },
        runProfileDiscoveryLive: async () => crawlerOsReceipt(),
      },
    })
    assert.equal(legacyAdapterCalled, 0, 'retired opportunity adapter must not run')
    assert.equal(upsertCalled, 0, 'retired writer must not run')
    assert.ok(result.ok)
  })

  it('records run history with counters', async () => {
    await runRobert({
      db, mode: 'observe', trigger: 'manual', profileIds: ['p1', 'p2'],
      deps: {
        loadProfileContext: async (_d, id) => ({ ...PROFILE_CTX, profile: { ...PROFILE_CTX.profile, id } }),
      },
    })
    const last = await latestRun(db)
    assert.ok(last)
    assert.equal(last.mode, 'observe')
    assert.equal(last.profiles_considered, 2)
  })

  it('getRobertStatus reports defaults', async () => {
    const status = await getRobertStatus(db)
    assert.equal(status.agent, 'Robert')
    assert.equal(status.enabled, false)
    assert.equal(status.allow_live_web, false)
    assert.equal(status.auto_ingest_verified, false)
  })
})

// Catalog-wide recommendation coverage moved to the authoritative Crawler OS:
// backend/crawler-os/tests/integration.test.mjs, pipeline.test.mjs, and
// robert.test.mjs. The retired catalog-miner assertions were unreachable from
// runRobert after that cutover.
