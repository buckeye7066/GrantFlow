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
import fs from 'node:fs'

import { calculateMatchScore } from '../../backend/services/matchingEngine.js'
import { upsertFundingOpportunity } from '../../backend/services/opportunityInserter.js'

// ---------------------------------------------------------------------------
// A) matchingEngine: unknown location → geoPoints -5, national bonus NOT applied
// ---------------------------------------------------------------------------

test('matchingEngine (A): unknown profile location scores lower than known location for national opp', () => {
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

  // Profile with known location should score higher than profile without
  const profileWithLocation = { state: 'OH' }
  const { score: scoreWithLocation } = calculateMatchScore(profileWithLocation, nationalOpp)

  // Unknown location must score meaningfully lower (at least 3 pts gap from weighted geo component)
  assert.ok(
    scoreWithLocation > score,
    `Expected profile with location (${scoreWithLocation}) to score higher than without (${score})`,
  )
  assert.ok(
    scoreWithLocation - score >= 3,
    `Expected meaningful gap (≥3 pts), got ${scoreWithLocation - score}`,
  )
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
      amount_text TEXT,
      amount_status TEXT,
      amount_confidence REAL,
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
      -- Production reality gate columns.
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
      funding_source_type TEXT,
      funding_category TEXT,
      usable_for_housing INTEGER DEFAULT 0,
      refund_potential INTEGER DEFAULT 0,
      eligibility_signals TEXT DEFAULT '[]',
      verification_status TEXT
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
  assert.ok(res.reason?.toLowerCase().includes('url'), `Expected URL-related reason, got: ${res.reason}`)

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
  assert.ok(res.reason?.toLowerCase().includes('url'), `Expected URL-related reason, got: ${res.reason}`)

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
  assert.equal(result.result_meta.match_threshold, 90, 'match_threshold should reflect the requested value')
  assert.equal(result.result_meta.match_threshold_requested, 90, 'match_threshold_requested (back-compat) should reflect the requested value')
  assert.equal(result.result_meta.match_threshold_used, 90, 'match_threshold_used (back-compat) should equal the requested value')
  assert.equal(
    result.result_meta.match_threshold_fallback_applied,
    false,
    'match_threshold_fallback_applied must always be false (no fallback allowed)',
  )
})

// ---------------------------------------------------------------------------
// E) Production seeding guard: scripts exit nonzero when NODE_ENV=production
// ---------------------------------------------------------------------------

function runScriptWith(scriptPath, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...extraEnv },
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
  const { code, stderr } = await runScriptWith(scriptPath, { NODE_ENV: 'production' })
  assert.ok(code !== 0, `Expected nonzero exit code in production, got code=${code}`)
  assert.ok(
    stderr.includes('[seed-profile-grants]') && stderr.includes('production'),
    `Expected production-guard message in stderr, got: ${stderr}`,
  )
})

test('seeding guard (E): scripts/seed-profile-grants.mjs exits nonzero in production', async () => {
  const scriptPath = path.resolve('scripts/seed-profile-grants.mjs')
  const { code, stderr } = await runScriptWith(scriptPath, { NODE_ENV: 'production' })
  assert.ok(code !== 0, `Expected nonzero exit code in production, got code=${code}`)
  assert.ok(
    stderr.includes('[seed-profile-grants]') && stderr.includes('production'),
    `Expected production-guard message in stderr, got: ${stderr}`,
  )
})

test('seeding guard (E): backend/scripts/seed-profile-grants.mjs exits nonzero when DISABLE_SEEDING=true', async () => {
  const scriptPath = path.resolve('backend/scripts/seed-profile-grants.mjs')
  const { code, stderr } = await runScriptWith(scriptPath, { NODE_ENV: 'development', DISABLE_SEEDING: 'true' })
  assert.ok(code !== 0, `Expected nonzero exit code when DISABLE_SEEDING=true, got code=${code}`)
  assert.ok(
    stderr.includes('[seed-profile-grants]'),
    `Expected guard message in stderr, got: ${stderr}`,
  )
})

test('seeding guard (E): scripts/seed-profile-grants.mjs exits nonzero when DISABLE_SEEDING=true', async () => {
  const scriptPath = path.resolve('scripts/seed-profile-grants.mjs')
  const { code, stderr } = await runScriptWith(scriptPath, { NODE_ENV: 'development', DISABLE_SEEDING: 'true' })
  assert.ok(code !== 0, `Expected nonzero exit code when DISABLE_SEEDING=true, got code=${code}`)
  assert.ok(
    stderr.includes('[seed-profile-grants]'),
    `Expected guard message in stderr, got: ${stderr}`,
  )
})

// ---------------------------------------------------------------------------
// F) seedOnStartup.js: blocks when NODE_ENV=production or DISABLE_SEEDING=true
// ---------------------------------------------------------------------------

test('seedOnStartup (F): seedFundingOpportunities returns 0 without inserting in production', async () => {
  const { seedFundingOpportunities } = await import('../../backend/utils/seedOnStartup.js')
  const origEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const db = createDb()
    const result = seedFundingOpportunities(db)
    assert.equal(result, 0, 'Expected 0 (blocked) in production')
    const count = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c
    assert.equal(Number(count), 0, 'No rows should have been inserted in production')
  } finally {
    process.env.NODE_ENV = origEnv
  }
})

test('seedOnStartup (F): seedFundingOpportunities returns 0 when DISABLE_SEEDING=true', async () => {
  const { seedFundingOpportunities } = await import('../../backend/utils/seedOnStartup.js')
  const origDisable = process.env.DISABLE_SEEDING
  const origEnv = process.env.NODE_ENV
  process.env.DISABLE_SEEDING = 'true'
  process.env.NODE_ENV = 'development'
  try {
    const db = createDb()
    const result = seedFundingOpportunities(db)
    assert.equal(result, 0, 'Expected 0 (blocked) when DISABLE_SEEDING=true')
  } finally {
    process.env.DISABLE_SEEDING = origDisable
    process.env.NODE_ENV = origEnv
  }
})

// ---------------------------------------------------------------------------
// G) Discovery route authority: profile searches must use Crawler OS matches
// ---------------------------------------------------------------------------

test('discovery (G): searchOpportunities uses Crawler OS before any raw catalog browse', () => {
  const text = fs.readFileSync(path.resolve('backend/routes/discovery.js'), 'utf8')
  const routeIdx = text.indexOf("router.post('/searchOpportunities'")
  assert.ok(routeIdx > 0, 'searchOpportunities route must exist')

  const osHelperIdx = text.indexOf('loadProfileOsResults(req, profileId', routeIdx)
  const rawCatalogIdx = text.indexOf("let query = 'SELECT * FROM funding_opportunities'", routeIdx)

  assert.ok(osHelperIdx > routeIdx, 'profile search must call loadProfileOsResults')
  assert.ok(rawCatalogIdx > routeIdx, 'admin raw catalog browse may still exist behind an explicit flag')
  assert.ok(
    osHelperIdx < rawCatalogIdx,
    'profile search must return Crawler OS results before the raw funding_opportunities catalog path',
  )
  // Profile-scoped, surfaced-matcher query. The matcher_version allowlist is
  // centralized in config/matchSurfacing.js (SURFACED_MATCHER_VERSIONS_SQL —
  // crawler-os + crawler-os-xmatch + web-llm) so read paths can't drift; the old
  // inlined `= 'crawler-os'` literal dropped real web-llm matches (#754).
  assert.match(text, /m\.profile_id = \? AND m\.matcher_version IN \$\{SURFACED_MATCHER_VERSIONS_SQL\}/)
  assert.match(text, /admin_global_catalog/)
  assert.match(text, /profile_id_required/)
})

test('discovery (G): frontend comprehensive match sends profile id, not a profile object', () => {
  const text = fs.readFileSync(path.resolve('src/components/discovery/discoveryHelpers.jsx'), 'utf8')
  assert.match(text, /const selectedProfileId = selectedOrg\?\.id \|\| selectedOrg\?\.profile_id/)
  assert.match(text, /profile_json: selectedProfileId/)
  assert.doesNotMatch(text, /profile_json:\s*selectedOrg[,}]/)
})

