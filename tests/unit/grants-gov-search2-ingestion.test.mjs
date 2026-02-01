import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { fetchGrantsGov } from '../../backend/services/sources/grantsGov.js'
import { ingestOpportunities } from '../../backend/services/sources/ingestionService.js'

function createInMemoryDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      source TEXT,
      source_id TEXT,
      title TEXT NOT NULL,
      sponsor TEXT,
      description TEXT,
      application_url TEXT,
      source_url TEXT,
      deadline TEXT,
      deadline_type TEXT,
      amount_min REAL,
      amount_max REAL,
      amount_description TEXT,
      is_national INTEGER,
      state TEXT,
      categories TEXT,
      keywords TEXT,
      eligibility_bullets TEXT,
      requires_match INTEGER,
      requires_501c3 INTEGER,
      match_percentage REAL,
      opportunity_type TEXT,
      is_active INTEGER,
      raw_source_payload TEXT,
      last_crawled TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE UNIQUE INDEX idx_opportunities_source_source_id
      ON funding_opportunities(source, source_id)
      WHERE source IS NOT NULL AND source_id IS NOT NULL;

    CREATE TABLE ingestion_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT,
      records_fetched INTEGER,
      records_inserted INTEGER,
      records_updated INTEGER,
      error_message TEXT
    );
  `)
  return db
}

test(
  'Grants.gov search2 ingestion: ingests at least one opportunity (no auth)',
  { timeout: 60_000 },
  async (t) => {
    const db = createInMemoryDb()
    try {
      let opportunities, metadata
      try {
        ({ opportunities, metadata } = await fetchGrantsGov({ limit: 25, offset: 0 }))
      } catch (error) {
        // Skip test if grants.gov is unreachable (common in CI environments)
        if (error?.message?.includes('ENOTFOUND') || error?.message?.includes('ETIMEDOUT')) {
          t.skip('grants.gov API not accessible in this environment')
          return
        }
        throw error // Re-throw other errors
      }

      assert.ok(metadata, 'metadata should be returned')
      assert.equal(metadata.source, 'grants.gov')
      assert.ok(Array.isArray(opportunities), 'opportunities should be an array')
      assert.ok(opportunities.length >= 1, `expected >=1 opportunity, got ${opportunities.length}`)

      // Ensure we de-dupe by opportunity number (source_id).
      const any = opportunities[0]
      assert.equal(any.source, 'grants.gov')
      assert.ok(any.source_id && String(any.source_id).length >= 3, 'source_id (opportunity number) should be present')

      const result = ingestOpportunities(db, opportunities, 'grants.gov')
      assert.equal(result.success, true)
      assert.ok(result.records_inserted + result.records_updated >= 1, 'should insert or update >=1 record')

      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM funding_opportunities WHERE source = 'grants.gov'`)
        .get().c
      assert.ok(Number(count) >= 1, 'DB should contain >=1 grants.gov record')

      // Idempotency: re-run ingestion, should not duplicate (should update or no-op).
      const result2 = ingestOpportunities(db, opportunities, 'grants.gov')
      assert.equal(result2.success, true)

      const count2 = db
        .prepare(`SELECT COUNT(*) AS c FROM funding_opportunities WHERE source = 'grants.gov'`)
        .get().c
      assert.equal(Number(count2), Number(count), 'record count should remain stable on re-ingest')
    } finally {
      db.close()
    }
  },
)

