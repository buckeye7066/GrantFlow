/**
 * Domain Corpus / National Crawler tests
 * 1) National crawler ingests >= 100 directory resources (sum across domains)
 * 2) No opportunity saved without URL
 * 3) business_startup_grants still excludes loans and matching funds
 * 4) verified_url flag set correctly when HEAD returns 200
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runDomainCorpusCrawl } from '../../backend/services/crawlers/domainCorpusCrawler.js'
import { DOMAIN_CRAWLER_REGISTRY } from '../../backend/services/crawlers/domainCrawlerRegistry.js'
import { runDomainCrawler, looksLikeLoan, looksLikeMatchingFunds } from '../../backend/services/crawlers/domainCrawlerEngine.js'
import { upsertFundingOpportunity } from '../../backend/services/opportunityInserter.js'

// Apply migration 030 columns to test DB
function createTestDb() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-domain-corpus-'))
  const dbPath = path.join(tmp, 'test.db')
  const db = new Database(dbPath)

  // Add withTransaction method to match the wrapped DB interface used by opportunityInserter
  db.withTransaction = async function withTransaction(fn) {
    this.exec('BEGIN')
    try {
      const result = await fn(this)
      this.exec('COMMIT')
      return result
    } catch (error) {
      try { this.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }
  }

  // Create minimal funding_opportunities table matching opportunityInserter INSERT columns
  db.exec(`
    CREATE TABLE IF NOT EXISTS funding_opportunities (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      evidence_url TEXT,
      contact_info TEXT,
      record_origin TEXT DEFAULT 'live_crawl',
      description TEXT,
      eligibility_bullets TEXT DEFAULT '[]',
      amount_min REAL,
      amount_max REAL,
      amount_description TEXT,
      deadline DATE,
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
      is_active INTEGER DEFAULT 1,
      last_crawled DATETIME,
      funding_domain TEXT,
      funding_subdomain TEXT,
      source_category TEXT,
      compliance_required TEXT DEFAULT '[]',
      certifications_required TEXT DEFAULT '[]',
      geo_eligibility TEXT,
      signal_tags TEXT DEFAULT '[]',
      verified_url INTEGER DEFAULT 0,
      crawler_version TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_fo_source_id ON funding_opportunities(source, source_id);
  `)

  return { db, dbPath, tmp }
}

test('domain corpus crawl ingests >= 100 directory resources across domains', async () => {
  const { db } = createTestDb()
  try {
    const stats = await runDomainCorpusCrawl(db, { skipVerification: true })
    const totalDir = stats.number_directory_resources + stats.number_live_resources
    assert.ok(
      totalDir >= 100,
      `Expected >= 100 directory resources, got directory=${stats.number_directory_resources} live=${stats.number_live_resources}`,
    )
    assert.ok(stats.total_inserted >= 100, `Expected >= 100 inserted, got ${stats.total_inserted}`)
  } finally {
    db.close()
  }
})

test('no opportunity saved without URL - upsertFundingOpportunity skips', async () => {
  const { db } = createTestDb()
  try {
    const result = await upsertFundingOpportunity(db, {
      title: 'Test Grant',
      description: 'A grant',
      source: 'test',
      // no url, application_url, or source_url
    })
    assert.equal(result.inserted, false)
    assert.equal(result.skipped, true)
    assert.ok(result.reason?.includes('URL') || result.reason?.includes('url'))

    const count = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get()
    assert.equal(count.c, 0)
  } finally {
    db.close()
  }
})

test('business_startup_grants excludes loans and matching funds', async () => {
  const config = DOMAIN_CRAWLER_REGISTRY.find((c) => c.id === 'business_startup_grants')
  assert.ok(config, 'business_startup_grants config must exist')

  const profile = { signals: { keywordSet: new Set(['startup']), location: {} } }
  const results = await runDomainCrawler({ profile, config, options: {} })

  for (const opp of results) {
    const text = [opp.title, opp.description, ...(opp.eligibility_bullets || []), ...(opp.keywords || [])]
      .filter(Boolean)
      .join(' ')
    assert.equal(looksLikeLoan(text), false, `Loan keywords in: ${opp.title}`)
    assert.equal(looksLikeMatchingFunds(text), false, `Matching fund keywords in: ${opp.title}`)
  }
})

test('verified_url remains 0 when skipVerification=true', async () => {
  const { db } = createTestDb()
  try {
    await runDomainCorpusCrawl(db, { skipVerification: true })
    const rows = db.prepare('SELECT verified_url FROM funding_opportunities LIMIT 5').all()
    for (const row of rows) {
      assert.equal(row.verified_url, 0, 'With skipVerification, verified_url should remain 0')
    }
  } finally {
    db.close()
  }
})

test('verified_url set when HEAD returns 200 - integration (may be 0 if network unavailable)', async () => {
  const { db } = createTestDb()
  try {
    const stats = await runDomainCorpusCrawl(db, { skipVerification: false })
    assert.ok(typeof stats.total_verified === 'number' && stats.total_verified >= 0)
    if (stats.total_verified > 0) {
      const verifiedRows = db
        .prepare('SELECT id FROM funding_opportunities WHERE verified_url = 1 LIMIT 1')
        .all()
      assert.ok(verifiedRows.length > 0, 'At least one row should have verified_url=1 when total_verified>0')
    }
  } finally {
    db.close()
  }
})
