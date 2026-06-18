/**
 * Mission System 1: the government-import path (ingestionService.ingestOpportunities,
 * used by grants.gov / USAspending / NIH ingest) must route active rows through
 * the canonical reality gate before insert — previously it only ran policy /
 * validator / reviewer and could persist e.g. a broken-link direct opportunity.
 *
 * Fixture isolation (verified): a broken-link active direct opportunity PASSES
 * policy + validator + reviewer but must be REJECTED by the reality gate.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Database from 'better-sqlite3'

import { applySqliteSchema } from '../../backend/db/ensureSqliteSchema.js'
import { ingestOpportunities } from '../../backend/services/sources/ingestionService.js'

const schemaSql = fs.readFileSync(new URL('../../backend/db/schema.sql', import.meta.url), 'utf8')

// ingestion_runs lives in migration 001 (not the base schema), and
// ingestOpportunities writes to it. Create it directly here (matching the
// migration's DDL) so the in-memory test DB is self-contained.
const INGESTION_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS ingestion_runs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source TEXT NOT NULL,
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    status TEXT CHECK(status IN ('running', 'completed', 'failed')) DEFAULT 'running',
    records_fetched INTEGER DEFAULT 0,
    records_inserted INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    error_message TEXT
  );
`

function freshDb() {
  const db = new Database(':memory:')
  applySqliteSchema(db, schemaSql)
  db.exec(INGESTION_RUNS_DDL)
  return db
}

const CLEAN_GRANT = {
  source: 'test-source',
  source_id: 'clean-1',
  title: 'Community Housing Grant',
  description: 'Direct grant for rent and utility help for families nationwide.',
  application_url: 'https://www.hudexchange.info/programs/community-housing/apply',
  source_url: 'https://www.hudexchange.info/programs/community-housing/apply',
  is_national: 1,
  is_active: 1,
  opportunity_type: 'grant',
  funding_type: 'grant',
  categories: '["housing"]',
  keywords: '["rent"]',
  eligibility_bullets: '[]',
  deadline: '2030-01-01',
  deadline_type: 'fixed',
}

const BROKEN_DIRECT = {
  ...CLEAN_GRANT,
  source_id: 'broken-1',
  title: 'Broken Link Housing Grant',
  link_status: 'broken',
}

test('import path inserts a clean grant and reality-gate-rejects a broken-link direct row', async () => {
  const db = freshDb()
  const result = await ingestOpportunities(db, [CLEAN_GRANT, BROKEN_DIRECT], 'test-source')

  assert.equal(result.success, true)
  assert.equal(result.records_inserted, 1, 'only the clean grant should be inserted')
  assert.equal(result.records_rejected_reality, 1, 'broken-link direct row rejected by reality gate')

  const rows = db.prepare('SELECT title FROM funding_opportunities').all().map((r) => r.title)
  assert.deepEqual(rows, ['Community Housing Grant'])
  assert.ok(!rows.includes('Broken Link Housing Grant'), 'broken-link row must not be persisted')
  db.close()
})

test('inactive reference rows (e.g. USAspending past awards) bypass the live-opportunity gate', async () => {
  const db = freshDb()
  // A past-award reference row: explicitly inactive, deliberately not a live
  // opportunity. It should still be ingested as reference data.
  const pastAward = {
    ...CLEAN_GRANT,
    source_id: 'past-award-1',
    title: '[Past award FY2019] Research Project',
    is_active: 0,
    link_status: 'broken',
  }
  const result = await ingestOpportunities(db, [pastAward], 'usaspending.gov')
  assert.equal(result.records_inserted, 1, 'inactive reference row ingested')
  assert.equal(result.records_rejected_reality, 0, 'inactive rows are not reality-gated')
  db.close()
})

test('import path PERSISTS the canonical reality verdict (reality_status not NULL)', async () => {
  // Regression: the gov-import path used to gate on assessReality but discard
  // the verdict, leaving reality_status = NULL and defeating the persisted-
  // verdict fast path in opportunityTrust.js (RC-8).
  const db = freshDb()
  const result = await ingestOpportunities(db, [CLEAN_GRANT], 'test-source')
  assert.equal(result.records_inserted, 1)

  const row = db
    .prepare('SELECT reality_status, opportunity_kind, source_trust_tier, reality_reasons FROM funding_opportunities WHERE source_id = ?')
    .get('clean-1')
  assert.ok(row, 'clean grant should be persisted')
  assert.ok(
    row.reality_status === 'allowed' || row.reality_status === 'downgraded',
    `reality_status must be persisted (got ${row.reality_status})`,
  )
  assert.ok(row.opportunity_kind, 'opportunity_kind must be persisted')
  assert.ok(row.source_trust_tier, 'source_trust_tier must be persisted')
  // reality_reasons is a JSON string array.
  assert.doesNotThrow(() => JSON.parse(row.reality_reasons || '[]'))
  db.close()
})
