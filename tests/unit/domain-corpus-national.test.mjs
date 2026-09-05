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

  // Match the production SqliteDb.withTransaction semantics: accept an async
  // callback and wrap with manual BEGIN/COMMIT/ROLLBACK. better-sqlite3's
  // native .transaction() wrapper rejects async callbacks, and callers like
  // bulkUpsertFundingOpportunities() await an async inner function.
  db.withTransaction = async function withTransaction(fn) {
    this.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn(this)
      this.exec('COMMIT')
      return result
    } catch (err) {
      try { this.exec('ROLLBACK') } catch { /* ignore rollback errors */ }
      throw err
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
      canonical_opportunity_key TEXT,
      source_url TEXT,
      evidence_url TEXT,
      contact_info TEXT,
      record_origin TEXT DEFAULT 'live_crawl',
      description TEXT,
      eligibility_bullets TEXT DEFAULT '[]',
      amount_min REAL,
      amount_max REAL,
      amount_description TEXT,
      amount_text TEXT,
      amount_status TEXT,
      amount_confidence REAL,
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
      -- Production reality gate: discovery vs verification are separate.
      discovered_at DATETIME,
      last_verified_at DATETIME,
      link_status TEXT DEFAULT 'unverified',
      link_status_code INTEGER,
      verification_method TEXT,
      verified_by TEXT,
      verification_error TEXT,
      opportunity_kind TEXT,
      source_trust_tier TEXT,
      -- RC-8: persisted reality verdict (migration 077).
      reality_status TEXT,
      reality_reasons TEXT,
      final_url TEXT,
      http_status INTEGER,
      profile_id TEXT,
      requires_501c3 INTEGER DEFAULT 0,
      requires_match INTEGER DEFAULT 0,
      match_percentage REAL,
      match_reasons TEXT DEFAULT '[]',
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      last_crawled DATETIME,
      funding_domain TEXT,
      funding_subdomain TEXT,
      source_category TEXT,
      compliance_required TEXT DEFAULT '[]',
      certifications_required TEXT DEFAULT '[]',
      geo_eligibility TEXT,
      signal_tags TEXT DEFAULT '[]',
      verified_url INTEGER DEFAULT 0,
      crawler_version TEXT,
      funding_source_type TEXT,
      funding_category TEXT,
      usable_for_housing INTEGER DEFAULT 0,
      refund_potential INTEGER DEFAULT 0,
      eligibility_signals TEXT DEFAULT '[]',
      verification_status TEXT,
      -- Pointer/direct classification (migration 068). The ingest choke point's
      -- ON CONFLICT clause reads excluded.result_kind, so the fixture must carry it.
      result_kind TEXT,
      -- Lifecycle columns the proof-restoring ON CONFLICT clause reads (schema.sql).
      status TEXT DEFAULT 'active',
      -- Award-calendar columns (schema.sql; added by the calendar PRs). The
      -- ingest choke point writes them, so the fixture must carry them or every
      -- insert throws SQLITE_ERROR "no column named expected_decision_date" and
      -- the crawl reports 0 rows.
      expected_decision_date DATE,
      decision_review_days INTEGER,
      reporting_requirements TEXT
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
    // Goal 1: inserter must reject records lacking an application path
    assert.strictEqual(result.inserted, false, 'inserted must be false when no URL provided')
    assert.strictEqual(result.skipped, true, 'skipped must be true when no URL provided')
    // Goal 8: suppression reason must be present and human-readable
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      'reason must be a non-empty string'
    )
    assert.ok(
      /url/i.test(result.reason),
      `Reason must reference missing URL, got: "${result.reason}"`
    )
    // Goal 8: nothing written to DB
    const count = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get()
    assert.strictEqual(count.c, 0, 'No rows should be inserted when URL is missing')
  } finally {
    db.close()
  }
})

test('business_startup_grants excludes loans and matching funds', async () => {
  const config = DOMAIN_CRAWLER_REGISTRY.find((c) => c.id === 'business_startup_grants')
  assert.ok(config, 'business_startup_grants config must exist')

  const profile = { signals: { keywordSet: new Set(['startup']), location: {} } }
  const results = await runDomainCrawler({ profile, config, options: {} })

  // Goal 7: crawler must return at least some candidates for a valid profile
  assert.ok(
    Array.isArray(results),
    'runDomainCrawler must return an array'
  )
  assert.ok(
    results.length > 0,
    `business_startup_grants crawler returned 0 results — possible suppression bug (Goal 7/Goal 8)`
  )

  for (const opp of results) {
    // Goal 1: every returned opportunity must have an application path
    assert.ok(
      opp.application_url || opp.source_url || opp.url,
      `Opportunity "${opp.title}" lacks any URL — violates Goal 1`
    )
    const text = [opp.title, opp.description, ...(opp.eligibility_bullets || []), ...(opp.keywords || [])]
      .filter(Boolean)
      .join(' ')
    // Goal 3: hard-reject loans and matching-fund requirements
    assert.equal(looksLikeLoan(text), false, `Loan keywords in: ${opp.title}`)
    assert.equal(looksLikeMatchingFunds(text), false, `Matching fund keywords in: ${opp.title}`)
  }
})

test('verified_url remains 0 when skipVerification=true', async () => {
  const { db } = createTestDb()
  try {
    await runDomainCorpusCrawl(db, { skipVerification: true })
    const allRows = db.prepare('SELECT verified_url FROM funding_opportunities').all()
    // Goal 1 / Goal 8: if anything was inserted it must have verified_url=0
    assert.ok(
      allRows.length > 0,
      'skipVerification crawl inserted 0 rows — corpus may be empty or crawler broken'
    )
    for (const row of allRows) {
      assert.strictEqual(
        row.verified_url,
        0,
        'With skipVerification=true, verified_url must remain 0 on every row'
      )
    }
  } finally {
    db.close()
  }
})

test('verified_url is set from a deterministic successful HEAD verification', async () => {
  const { db } = createTestDb()
  try {
    let verificationCalls = 0
    const stats = await runDomainCorpusCrawl(db, {
      skipVerification: false,
      headForVerification: async () => {
        verificationCalls += 1
        return { ok: true, status: 200 }
      },
    })
    assert.ok(verificationCalls > 0, 'Expected the crawler to verify at least one inserted URL')
    assert.equal(stats.total_verified, verificationCalls)
    const verifiedRows = db
      .prepare('SELECT id FROM funding_opportunities WHERE verified_url = 1')
      .all()
    assert.equal(verifiedRows.length, verificationCalls)
  } finally {
    db.close()
  }
})
