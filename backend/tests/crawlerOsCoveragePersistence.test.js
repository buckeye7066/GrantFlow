/**
 * Guards the 2026-07-20 fix: the Crawler OS cutover (2026-06-22, commit
 * 9a59f0d1) deleted the legacy /real-crawlers/run pipeline body — including
 * its only call to persistCoverageOutcomes(), the SOLE writer of the durable
 * crawler_source_runs table the admin Crawl Coverage & Health dashboard
 * (GET /api/admin/crawl-coverage) reads — but never wired an equivalent write
 * for the new engine. Nothing has written a fresh row since; the dashboard
 * was frozen on the legacy engine's last ~36 hours of runs (2026-06-20/21),
 * which is why every one of ~20 "comprehensive" rows showed Found=0 for a
 * month even though the Crawler OS kept finding real matches the whole time.
 *
 * These tests prove:
 *   1. persistSourceCoverage() maps pipeline.js's per-source outcome shape
 *      onto crawler_source_runs' columns correctly (unit-level, incl. the
 *      SKIPPED/failed/found semantics and honest degradation when the table
 *      is missing).
 *   2. runProfileDiscoveryLive() — the SAME engine every live/scheduled crawl
 *      path now uses — writes a crawler_source_runs row end-to-end, so a
 *      regression here fails on the exact symptom the owner saw (Queried=1,
 *      Found=0 despite a real result), not just on the persistence helper in
 *      isolation.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { persistSourceCoverage } from '../services/crawlerOsCoveragePersistence.js'
import { runProfileDiscoveryLive } from '../services/crawlerOsService.js'
import { CRAWLER_OUTCOME } from '../crawler-os/contract.js'

function makeSourceRunsDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE crawler_source_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crawler_run_id TEXT NOT NULL,
      profile_id TEXT,
      crawler_type TEXT,
      source_id TEXT NOT NULL,
      source_label TEXT,
      planned INTEGER NOT NULL DEFAULT 0,
      queried INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      found INTEGER NOT NULL DEFAULT 0,
      directory INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)
  raw.dialect = 'sqlite'
  return raw
}

describe('persistSourceCoverage (unit)', () => {
  it('writes a queried+found row for an OK source, using the OS registry label/directory flag', async () => {
    const db = makeSourceRunsDb()
    await persistSourceCoverage(db, {
      crawlerRunId: 'run-1',
      profileId: 'p-1',
      crawlerType: 'comprehensive',
      sources: [
        { source_id: 'grants_gov', outcome: CRAWLER_OUTCOME.OK, stored: 2, existing: 1 },
      ],
    })
    const row = db.prepare('SELECT * FROM crawler_source_runs WHERE crawler_run_id = ?').get('run-1')
    expect(row).toBeTruthy()
    expect(row.source_id).toBe('grants_gov')
    expect(row.planned).toBe(1)
    expect(row.queried).toBe(1)
    expect(row.failed).toBe(0)
    // found = stored + existing (a re-found already-known opportunity still
    // counts — the census must not read "known" as "not found").
    expect(row.found).toBe(3)
    expect(typeof row.source_label).toBe('string')
    expect(row.source_label.length).toBeGreaterThan(0)
  })

  it('a SKIPPED source is planned but NOT queried, and never counted as failed', async () => {
    const db = makeSourceRunsDb()
    await persistSourceCoverage(db, {
      crawlerRunId: 'run-2',
      profileId: 'p-1',
      crawlerType: 'comprehensive',
      sources: [
        { source_id: 'sam_gov', outcome: CRAWLER_OUTCOME.SKIPPED, reason: 'missing_env:SAM_GOV_API_KEY' },
      ],
    })
    const row = db.prepare('SELECT * FROM crawler_source_runs WHERE crawler_run_id = ?').get('run-2')
    expect(row.planned).toBe(1)
    expect(row.queried).toBe(0)
    expect(row.failed).toBe(0)
    expect(row.error).toBe('missing_env:SAM_GOV_API_KEY')
  })

  it('a FETCH_ERROR source is queried AND failed', async () => {
    const db = makeSourceRunsDb()
    await persistSourceCoverage(db, {
      crawlerRunId: 'run-3',
      profileId: 'p-1',
      crawlerType: 'comprehensive',
      sources: [{ source_id: 'grants_gov', outcome: CRAWLER_OUTCOME.FETCH_ERROR, reason: 'status:503' }],
    })
    const row = db.prepare('SELECT * FROM crawler_source_runs WHERE crawler_run_id = ?').get('run-3')
    expect(row.queried).toBe(1)
    expect(row.failed).toBe(1)
    expect(row.found).toBe(0)
  })

  it('an EMPTY (clean, zero-result) source is queried, not failed, found=0', async () => {
    const db = makeSourceRunsDb()
    await persistSourceCoverage(db, {
      crawlerRunId: 'run-4',
      profileId: 'p-1',
      crawlerType: 'comprehensive',
      sources: [{ source_id: 'grants_gov', outcome: CRAWLER_OUTCOME.EMPTY }],
    })
    const row = db.prepare('SELECT * FROM crawler_source_runs WHERE crawler_run_id = ?').get('run-4')
    expect(row.queried).toBe(1)
    expect(row.failed).toBe(0)
    expect(row.found).toBe(0)
  })

  it('surfaces (but never fabricates a write for) a missing table — the caller is expected to swallow this', async () => {
    const raw = new Database(':memory:') // no crawler_source_runs table
    raw.dialect = 'sqlite'
    // Mirrors the historical persistCoverageOutcomes() contract: when NOTHING
    // in the batch could be written, the failure propagates so it is visible
    // to logs — but the caller (runProfileDiscoveryLive) wraps this in its own
    // try/catch ("coverage telemetry must never fail the crawl"), so a missing
    // table degrades to a log line, never a failed crawl.
    await expect(
      persistSourceCoverage(raw, {
        crawlerRunId: 'run-5',
        profileId: 'p-1',
        crawlerType: 'comprehensive',
        sources: [{ source_id: 'grants_gov', outcome: CRAWLER_OUTCOME.OK, stored: 1 }],
      }),
    ).rejects.toThrow(/no such table/i)
  })

  it('no-ops on an empty/missing sources array without throwing', async () => {
    const db = makeSourceRunsDb()
    await expect(persistSourceCoverage(db, { crawlerRunId: 'run-6', sources: [] })).resolves.toEqual({ written: 0 })
    await expect(persistSourceCoverage(db, { crawlerRunId: 'run-7' })).resolves.toEqual({ written: 0 })
  })
})

describe('runProfileDiscoveryLive → crawler_source_runs (end-to-end regression guard)', () => {
  function makeFullDb() {
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
      CREATE TABLE crawler_source_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crawler_run_id TEXT NOT NULL, profile_id TEXT, crawler_type TEXT,
        source_id TEXT NOT NULL, source_label TEXT,
        planned INTEGER NOT NULL DEFAULT 0, queried INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, found INTEGER NOT NULL DEFAULT 0,
        directory INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER, error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `)
    raw.dialect = 'sqlite'
    return raw
  }

  const GRANTS_GOV_BODY = JSON.stringify({
    data: {
      oppHits: [{
        id: '900002', number: 'TEST-900002',
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

  it('a live discovery run leaves a queried+found crawler_source_runs row (the dashboard\'s exact read path)', async () => {
    const db = makeFullDb()
    db.prepare(
      `INSERT INTO profiles (id, primary_type, applicant_type, state, county, city, tags)
       VALUES ('p-cov', 'nonprofit', 'nonprofit', 'TN', 'Bradley', 'Cleveland', '["community"]')`,
    ).run()

    const { run } = await runProfileDiscoveryLive({
      db, profileId: 'p-cov', fetcher: makeStubFetcher(), crawlerType: 'comprehensive',
    })

    const rows = db.prepare(
      `SELECT * FROM crawler_source_runs WHERE crawler_run_id = ?`,
    ).all(run.run_id)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.crawler_type === 'comprehensive')).toBe(true)
    expect(rows.every((r) => r.profile_id === 'p-cov')).toBe(true)

    const grantsGovRow = rows.find((r) => r.source_id === 'grants_gov')
    expect(grantsGovRow).toBeTruthy()
    expect(grantsGovRow.queried).toBe(1)
    // This is the exact regression: before the fix, NOTHING wrote this table
    // for a Crawler OS run, so this row (and therefore this assertion) simply
    // did not exist. A source that genuinely found a real result must report
    // found > 0, not the honest-looking-but-wrong "Queried=1, Found=0" the
    // owner saw across every "comprehensive" row for a month.
    expect(grantsGovRow.found).toBeGreaterThan(0)
  }, 20000)

  it('a dry run never writes crawler_source_runs (nothing was actually persisted)', async () => {
    const db = makeFullDb()
    db.prepare(
      `INSERT INTO profiles (id, primary_type, applicant_type, state, county, city, tags)
       VALUES ('p-dry', 'nonprofit', 'nonprofit', 'TN', 'Bradley', 'Cleveland', '["community"]')`,
    ).run()

    await runProfileDiscoveryLive({ db, profileId: 'p-dry', fetcher: makeStubFetcher(), dryRun: true })

    const count = db.prepare(`SELECT COUNT(*) AS c FROM crawler_source_runs`).get().c
    expect(count).toBe(0)
  }, 20000)
})
