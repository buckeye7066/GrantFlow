import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runNationalZipCrawl } from '../../backend/services/crawlers/nationalZipCrawler.js'
import { applySqliteSchema } from '../../backend/db/ensureSqliteSchema.js'

// The geo crawler now persists through the canonical gated inserter
// (upsertFundingOpportunity), which requires the full funding_opportunities
// schema. Build the real schema, then drop the geo-progress tables so the
// crawler's self-heal path is still exercised.
const SCHEMA_SQL = readFileSync(new URL('../../backend/db/schema.sql', import.meta.url), 'utf8')

test('geo crawl: self-heals when geo progress tables are missing (sqlite)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-geo-missing-'))
  const dbPath = path.join(tmp, 'test.db')
  const fixturesDir = path.join(tmp, 'fixtures')
  mkdirSync(fixturesDir, { recursive: true })
  const jobId = 'job-test-geo-missing'

  // Minimal fixture: one opportunity for a single ZIP, deterministic and no network.
  writeFileSync(
    path.join(fixturesDir, 'zip_43004.json'),
    JSON.stringify([
      {
        title: 'Fixture Geo Opportunity',
        sponsor: 'Fixture Sponsor',
        description: 'Fixture description',
        url: 'https://www.grants.gov/fixture-opportunity',
        source: 'fixture_geo',
        source_id: 'fixture-43004-1',
        state: 'OH',
        is_national: false,
        categories: ['test'],
        keywords: ['43004', 'oh'],
        opportunity_type: 'benefit',
        type: 'PROGRAM',
        requires_match: false,
        match_percentage: 0,
        last_verified_at: new Date().toISOString(),
      },
    ]),
    'utf8',
  )

  const db = new Database(dbPath)

  // Build the FULL production schema (funding_opportunities needs every column
  // the canonical inserter writes), then DROP the geo-progress tables so the
  // crawler's self-heal path is exercised. Intentionally leaves
  // national_zip_progress / geo_state_runs missing.
  applySqliteSchema(db, SCHEMA_SQL)
  db.exec('DROP TABLE IF EXISTS geo_state_runs')
  db.exec('DROP TABLE IF EXISTS national_zip_progress')

  // Insert a matching crawler_jobs row so geo_state_runs.job_id FK can be satisfied.
  db.prepare("INSERT INTO crawler_jobs (id, type) VALUES (?, 'national_zip_scan')").run(jobId)
  db.close()

  const result = await runNationalZipCrawl(dbPath, {
    state: 'OH',
    zip_list: ['43004'],
    max_zips: 1,
    batch_size: 1,
    rate_limit_ms: 0,
    min_sources_per_zip: 1,
    discover_local_resources: false,
    fixtures_dir: fixturesDir,
    resume: false,
    // This is the failing prod path: state runs are recorded when a state is provided.
    job_id: jobId,
  })

  assert.equal(result.processed, 1)
  assert.ok(result.sources >= 1)

  const verifyDb = new Database(dbPath)
  const hasNational = verifyDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='national_zip_progress'")
    .get()
  const hasStateRuns = verifyDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='geo_state_runs'")
    .get()
  assert.ok(hasNational, 'expected national_zip_progress table to be created')
  assert.ok(hasStateRuns, 'expected geo_state_runs table to be created')

  const oppCount = verifyDb.prepare('SELECT COUNT(*) AS c FROM funding_opportunities').get()?.c
  assert.ok(Number(oppCount || 0) >= 1)

  const runRow = verifyDb.prepare('SELECT state, status, processed_zips, sources_inserted FROM geo_state_runs LIMIT 1').get()
  assert.equal(runRow?.state, 'OH')
  assert.equal(runRow?.status, 'completed')
  assert.equal(Number(runRow?.processed_zips || 0), 1)
  assert.ok(Number(runRow?.sources_inserted || 0) >= 1)

  verifyDb.close()
})

