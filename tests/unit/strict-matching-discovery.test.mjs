/**
 * Tests for strict profile-driven discovery / matching behavior:
 * 1. matchingEngine: unknown profile location now applies a -5 penalty
 * 2. matchingEngine: national eligibility bonus only applies when profile has a known location
 * 3. opportunityInserter: URL validation applies to ALL record origins (live_crawl AND curated_verified)
 * 4. itemCrawler: no fallback threshold; match_threshold_fallback_applied is always false
 * 5. Production seeding guard: seed scripts exit nonzero in production
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import path from 'node:path'

import { calculateMatchScore } from '../../backend/services/matchingEngine.js'
import { upsertFundingOpportunity } from '../../backend/services/opportunityInserter.js'

// ---------------------------------------------------------------------------
// A) matchingEngine: unknown location → geoPoints -5, national bonus NOT applied
// ---------------------------------------------------------------------------

test('matchingEngine (A): unknown profile location applies a -5 geo penalty', () => {
  const emptyProfile = {} // no location, no type
  const nationalOpp = {
    title: 'National Grant',
    description: 'Open to all US residents',
    is_national: true,
    state: 'nationwide',
    eligibility_bullets: [],
    keywords: [],
    categories: [],
  }

  const { score, reasons } = calculateMatchScore(emptyProfile, nationalOpp)

  // Must NOT say "National eligibility" — that bonus must not apply when location is unknown
  const hasNationalBonus = reasons.some((r) => r === 'National eligibility')
  assert.ok(
    !hasNationalBonus,
    `Expected no "National eligibility" bonus when profile location is unknown, got: ${JSON.stringify(reasons)}`,
  )

  // The geo contribution must be -5 (unknown penalty), not 0 or +8
  // We verify this by comparing with a profile that has a known location
  const profileWithLocation = { state: 'OH' }
  const { score: scoreWithLocation } = calculateMatchScore(profileWithLocation, nationalOpp)

  // scoreWithLocation includes +8 national bonus; emptyProfile should be 13 pts lower (-5 vs +8)
  assert.equal(
    scoreWithLocation - score,
    13,
    `Expected 13-point gap between unknown location (-5) and national bonus (+8), got ${scoreWithLocation - score}`,
  )

  // Score must stay low for an empty profile with no matching attributes
  assert.ok(score <= 10, `Score (${score}) should stay low for empty profile against national opp`)
})

// ---------------------------------------------------------------------------
// B) matchingEngine: known location + national opportunity → national bonus applied
// ---------------------------------------------------------------------------

test('matchingEngine (B): national opp DOES award +8 bonus when profile has a known state', () => {
  const profile = { primary_type: 'individual_need', state: 'CA' }
  const nationalOpp = {
    title: 'National Scholarship',
    description: 'Available to all US residents',
    is_national: true,
    state: 'nationwide',
    eligibility_bullets: ['individuals', 'residents'],
    keywords: [],
    categories: [],
  }

  const { reasons } = calculateMatchScore(profile, nationalOpp)

  const hasNationalBonus = reasons.some((r) => r === 'National eligibility')
  assert.ok(
    hasNationalBonus,
    `Expected "National eligibility" bonus when profile has a known state, got: ${JSON.stringify(reasons)}`,
  )
})

// ---------------------------------------------------------------------------
// C) opportunityInserter: rejects when ALL urls missing — both live_crawl AND curated_verified
// ---------------------------------------------------------------------------

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
      contact_info TEXT DEFAULT NULL
    );
    CREATE UNIQUE INDEX funding_opportunities_source_source_id_uniq
      ON funding_opportunities(source, source_id);
  `)
  return db
}

test('opportunityInserter (C): live_crawl record without URL is rejected', async () => {
  const db = createDb()
  const res = await upsertFundingOpportunity(db, {
    title: 'No URL Live Crawl Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'live-no-url-1',
    record_origin: 'live_crawl',
  })

  assert.equal(res.skipped, true, 'Expected skipped=true for live_crawl record without URL')
  assert.ok(res.reason?.includes('URL'), `Expected URL-related reason, got: ${res.reason}`)

  const count = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c
  assert.equal(Number(count), 0, 'No records should have been inserted')
})

test('opportunityInserter (C): curated_verified record without URL is rejected', async () => {
  const db = createDb()
  const res = await upsertFundingOpportunity(db, {
    title: 'No URL Curated Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'curated-no-url-1',
    record_origin: 'curated_verified',
  })

  assert.equal(res.skipped, true, 'Expected skipped=true for curated_verified record without URL')
  assert.ok(res.reason?.includes('URL'), `Expected URL-related reason, got: ${res.reason}`)

  const count = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c
  assert.equal(Number(count), 0, 'No records should have been inserted')
})

test('opportunityInserter (C): curated_verified record WITH URL is accepted', async () => {
  const db = createDb()
  const res = await upsertFundingOpportunity(db, {
    title: 'Valid Curated Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'curated-with-url-1',
    source_url: 'https://www.grants.gov/search-grants',
    record_origin: 'curated_verified',
  })

  assert.equal(res.inserted, true, 'Expected inserted=true for curated record with URL')
})

// ---------------------------------------------------------------------------
// D) itemCrawler: no fallback; matched=0 when threshold not met, fallback flag always false
// ---------------------------------------------------------------------------

test('itemCrawler (D): no fallback threshold; matched=0 and fallback_applied=false when no items qualify', async () => {
  const { processItemCrawlerJob } = await import('../../backend/services/itemCrawler.js')
  const db = createDb()

  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const tmp = mkdtempSync(path.join(tmpdir(), 'item-crawler-test-'))
  writeFileSync(path.join(tmp, 'item_funding_sources.json'), '[]')

  const result = await processItemCrawlerJob({
    db,
    job: {
      parameters: {
        item_keywords: ['unicorn_nonexistent_xyz'],
        match_threshold: 90,
        max_results: 10,
      },
    },
    dataDir: tmp,
    profileContext: { profile: { state: 'OH' }, sections: {} },
  })

  assert.equal(result.matched, 0, `Expected 0 matched results but got ${result.matched}`)
  assert.equal(result.result_meta.match_threshold, 90, 'Threshold in result_meta should reflect the requested value')
  assert.equal(
    result.result_meta.match_threshold_fallback_applied,
    false,
    'match_threshold_fallback_applied must always be false (no fallback allowed)',
  )
})

// ---------------------------------------------------------------------------
// E) Production seeding guard: scripts exit nonzero when NODE_ENV=production
// ---------------------------------------------------------------------------

function runScriptInProduction(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'pipe',
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => (stderr += d))
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

test('seeding guard (E): backend/scripts/seed-profile-grants.mjs exits nonzero in production', async () => {
  const scriptPath = path.resolve('backend/scripts/seed-profile-grants.mjs')
  const { code, stderr } = await runScriptInProduction(scriptPath)
  assert.ok(code !== 0, `Expected nonzero exit code in production, got code=${code}`)
  assert.ok(
    stderr.includes('[seed-profile-grants]') && stderr.includes('production'),
    `Expected production-guard message in stderr, got: ${stderr}`,
  )
})

test('seeding guard (E): scripts/seed-profile-grants.mjs exits nonzero in production', async () => {
  const scriptPath = path.resolve('scripts/seed-profile-grants.mjs')
  const { code, stderr } = await runScriptInProduction(scriptPath)
  assert.ok(code !== 0, `Expected nonzero exit code in production, got code=${code}`)
  assert.ok(
    stderr.includes('[seed-profile-grants]') && stderr.includes('production'),
    `Expected production-guard message in stderr, got: ${stderr}`,
  )
})

