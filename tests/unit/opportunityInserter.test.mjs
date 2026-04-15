import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { upsertFundingOpportunity } from '../../backend/services/opportunityInserter.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      evidence_url TEXT,
      record_origin TEXT DEFAULT 'live_crawl',
      description TEXT,
      eligibility_bullets TEXT DEFAULT '[]',
      amount_min REAL,
      amount_max REAL,
      amount_description TEXT,
      deadline TEXT,
      deadline_type TEXT,
      application_url TEXT,
      is_national INTEGER DEFAULT 0,
      state TEXT,
      categories TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      opportunity_type TEXT,
      funding_type TEXT,
      type TEXT DEFAULT 'OPPORTUNITY',
      last_verified_at DATETIME,
      profile_id TEXT,
      requires_501c3 INTEGER DEFAULT 0,
      requires_match INTEGER DEFAULT 0,
      match_percentage REAL,
      match_reasons TEXT DEFAULT '[]',
      notes TEXT,
      is_loan INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      last_crawled DATETIME,
      contact_info TEXT DEFAULT NULL,
      funding_domain TEXT,
      funding_subdomain TEXT,
      source_category TEXT,
      compliance_required TEXT DEFAULT '[]',
      certifications_required TEXT DEFAULT '[]',
      geo_eligibility TEXT,
      signal_tags TEXT DEFAULT '[]',
      verified_url INTEGER DEFAULT 0,
      crawler_version TEXT,
      funding_source_type TEXT
    );

    CREATE UNIQUE INDEX funding_opportunities_source_source_id_uniq
      ON funding_opportunities(source, source_id);
  `)
  return db
}

test('opportunityInserter: live_crawl requires evidence/source/application URL', async () => {
  const db = createDb()
  const res = await upsertFundingOpportunity(db, {
    title: 'No URL Opp',
    sponsor: 'Nobody',
    source: 'unit_test',
    source_id: 'no-url-1',
    record_origin: 'live_crawl',
  })

  assert.equal(res.skipped, true)
  const count = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c
  assert.equal(Number(count), 0)
})

test('opportunityInserter: inserts live crawl and updates existing row', async () => {
  const db = createDb()

  const inserted = await upsertFundingOpportunity(db, {
    title: 'Example Opportunity',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'opp-1',
    source_url: 'https://www.grants.gov/',
    application_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
    description: 'v1',
  })
  assert.equal(inserted.inserted, true)

  const row1 = db
    .prepare(
      `SELECT description, evidence_url, last_verified_at
       FROM funding_opportunities
       WHERE source = ? AND source_id = ?`,
    )
    .get('unit_test', 'opp-1')
  assert.equal(row1.description, 'v1')
  assert.ok(row1.evidence_url)
  assert.ok(row1.last_verified_at)

  const updated = await upsertFundingOpportunity(db, {
    title: 'Example Opportunity',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'opp-1',
    source_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
    description: 'v2',
  })
  assert.equal(updated.updated, true)

  const row2 = db
    .prepare(`SELECT description FROM funding_opportunities WHERE source = ? AND source_id = ?`)
    .get('unit_test', 'opp-1')
  assert.equal(row2.description, 'v2')
})

test('opportunityInserter: baseline cannot downgrade verified record', async () => {
  const db = createDb()

  // Create a verified record (live_crawl will auto-set last_verified_at)
  await upsertFundingOpportunity(db, {
    title: 'Verified Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'verified-1',
    source_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
  })

  // Baseline/unverified incoming should not overwrite
  const res = await upsertFundingOpportunity(db, {
    title: 'Verified Opp (baseline overwrite attempt)',
    sponsor: 'Other',
    source: 'unit_test',
    source_id: 'verified-1',
    source_url: 'https://www.grants.gov/',
    record_origin: 'curated_verified',
    last_verified_at: null,
  })

  assert.equal(res.skipped, true)
  const row = db
    .prepare(`SELECT title, sponsor FROM funding_opportunities WHERE source = ? AND source_id = ?`)
    .get('unit_test', 'verified-1')
  assert.equal(row.title, 'Verified Opp')
  assert.equal(row.sponsor, 'Agency')
})

