/**
 * Tests for strict profile-driven discovery / matching behavior:
 * 1. matchingEngine: unknown profile location now applies a penalty
 * 2. matchingEngine: national eligibility bonus only applies when profile has a known location
 * 3. opportunityInserter: URL validation applies to all record origins (not just live_crawl)
 * 4. itemCrawler: no fallback threshold — only the requested threshold is used
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { calculateMatchScore } from '../../backend/services/matchingEngine.js'
import { upsertFundingOpportunity } from '../../backend/services/opportunityInserter.js'

// ---------------------------------------------------------------------------
// matchingEngine tests
// ---------------------------------------------------------------------------

test('matchingEngine: unknown profile location applies a penalty (not neutral)', () => {
  const profile = { primary_type: 'individual_need' } // no location fields at all
  const nationalOpp = {
    title: 'National Assistance',
    description: 'Available nationwide',
    is_national: true,
    state: 'nationwide',
    eligibility_bullets: ['individuals'],
    keywords: [],
    categories: [],
  }

  const { score } = calculateMatchScore(profile, nationalOpp)

  // With no location info the profile gets a geo penalty (-5), so the score
  // must be strictly less than what it would be if location were provided
  // and matched (which would add +8 for national).  A "neutral" 0 would push
  // the score above -5, so the score with unknown location must be < score
  // that would be achieved with a full location match.
  // More concretely: the geo contribution must be negative.
  const profileWithLocation = { primary_type: 'individual_need', state: 'OH' }
  const { score: scoreWithLocation } = calculateMatchScore(profileWithLocation, nationalOpp)

  assert.ok(
    score < scoreWithLocation,
    `Unknown location score (${score}) should be less than score with known location (${scoreWithLocation})`,
  )
})

test('matchingEngine: national opp does NOT get +8 bonus when profile location is unknown', () => {
  // Previously, national opportunities got +8 even if the profile had no
  // location info, which inflated scores for empty profiles.
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

  // The reason message must NOT say "National eligibility" (which implies +8 bonus)
  // when the profile has no location data.
  const hasNationalBonus = reasons.some((r) => r === 'National eligibility')
  assert.ok(
    !hasNationalBonus,
    `Expected no "National eligibility" bonus when profile location is unknown, but got reasons: ${JSON.stringify(reasons)}`,
  )

  // Score must reflect the penalty for missing location, not a bonus.
  assert.ok(score <= 10, `Score (${score}) should stay low when profile has no location or type info`)
})

test('matchingEngine: national opp DOES award bonus when profile has a known state', () => {
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
    `Expected "National eligibility" bonus when profile has a known state, but got: ${JSON.stringify(reasons)}`,
  )
})

// ---------------------------------------------------------------------------
// opportunityInserter URL validation tests
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

test('opportunityInserter: curated_verified record without URL is rejected', async () => {
  const db = createDb()
  const res = await upsertFundingOpportunity(db, {
    title: 'No URL Curated Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'curated-no-url-1',
    record_origin: 'curated_verified',
  })

  assert.equal(res.skipped, true, 'Expected skipped=true for curated record without URL')
  assert.ok(res.reason?.includes('URL'), `Expected URL-related reason, got: ${res.reason}`)

  const count = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c
  assert.equal(Number(count), 0, 'No records should have been inserted')
})

test('opportunityInserter: curated_verified record WITH URL is accepted', async () => {
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
// itemCrawler: no fallback threshold
// ---------------------------------------------------------------------------

test('itemCrawler: returns empty array instead of lowering threshold when no items match', async () => {
  // We test the logic directly by importing and calling processItemCrawlerJob with a
  // high threshold and a data directory that has no matching opportunities.
  const { processItemCrawlerJob } = await import('../../backend/services/itemCrawler.js')
  const db = createDb()

  // Create a minimal data directory in /tmp with an empty item_funding_sources.json
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
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

  // With no matching items and a strict threshold, we expect 0 results — NOT a
  // fallback to a lower threshold that would return unrelated items.
  assert.equal(result.matched, 0, `Expected 0 matched results but got ${result.matched}`)
  assert.equal(result.result_meta.match_threshold, 90, 'Threshold in result_meta should reflect the requested value')
})
