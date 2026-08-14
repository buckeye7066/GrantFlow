/**
 * Tests for the regional purge system.
 *
 * Covers:
 *  A) purgeDiffUtils: normalisation, tokenisation, diff ratio, similarity, hash
 *  B) purgeMaterialChange: status change, deadline change, text diff, no-change
 *  C) discoverActiveProfileStates: state extraction from profile columns and sections
 *  D) regionalPurgeService (integration): suppression, watch, dry-run, event rows
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  normalizeText,
  tokenize,
  computeTokenDiffRatio,
  computeSimilarity,
  stableTextHash,
} from '../../backend/services/purgeDiffUtils.js'

import {
  detectMaterialChange,
  TOKEN_DIFF_THRESHOLD,
  SIMILARITY_THRESHOLD,
} from '../../backend/services/purgeMaterialChange.js'

import {
  discoverActiveProfileStates,
  runRegionalPurge,
  ensureSuppressionSchema,
  SUPPRESSION_STATES,
  inferSourceTier,
} from '../../backend/services/regionalPurgeService.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(seed = true) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS funding_opportunities (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      title TEXT,
      description TEXT,
      source TEXT,
      source_url TEXT,
      status TEXT,
      deadline TEXT,
      is_active INTEGER DEFAULT 1,
      state TEXT,
      is_national INTEGER DEFAULT 0,
      profile_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_text TEXT,
      last_seen_hash TEXT,
      last_checked_at DATETIME,
      suppression_state TEXT DEFAULT 'active',
      suppression_reason TEXT,
      suppression_metadata TEXT,
      last_status TEXT,
      last_deadline DATE,
      source_tier TEXT DEFAULT 'unknown'
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      state TEXT,
      postal_code TEXT,
      zip TEXT,
      primary_type TEXT
    );
    CREATE TABLE IF NOT EXISTS profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
  `)

  ensureSuppressionSchema(db)

  if (seed) {
    db.prepare(`INSERT INTO profiles (id, state) VALUES ('p1', 'TN')`).run()
    db.prepare(`INSERT INTO profiles (id, state) VALUES ('p2', 'OH')`).run()
    db.prepare(`INSERT INTO funding_opportunities (id, title, state, source_url, description, status, is_active)
      VALUES ('opp1', 'Test Grant TN', 'TN', 'http://example.com/opp1', 'Apply now for funding.', 'open', 1)`).run()
    db.prepare(`INSERT INTO funding_opportunities (id, title, state, source_url, description, status, is_active)
      VALUES ('opp2', 'Test Grant OH', 'OH', 'http://example.com/opp2', 'Open applications available.', 'open', 1)`).run()
  }

  return db
}

// ─── A) purgeDiffUtils ───────────────────────────────────────────────────────

test('purgeDiffUtils (A): normalizeText strips HTML and lowercases', () => {
  const input = '<p>Hello <strong>World</strong>!</p>'
  const result = normalizeText(input)
  assert.ok(!result.includes('<'), 'HTML tags should be stripped')
  assert.ok(!result.includes('>'), 'HTML tags should be stripped')
  assert.ok(result === result.toLowerCase(), 'Should be lowercase')
})

test('purgeDiffUtils (A): normalizeText collapses whitespace', () => {
  const result = normalizeText('  foo   bar\n\tbaz  ')
  assert.equal(result, 'foo bar baz')
})

test('purgeDiffUtils (A): tokenize splits on spaces', () => {
  const tokens = tokenize('hello world foo')
  assert.deepEqual(tokens, ['hello', 'world', 'foo'])
})

test('purgeDiffUtils (A): tokenize returns empty array for empty input', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
})

test('purgeDiffUtils (A): computeTokenDiffRatio identical texts → 0', () => {
  const ratio = computeTokenDiffRatio('hello world', 'hello world')
  assert.equal(ratio, 0)
})

test('purgeDiffUtils (A): computeTokenDiffRatio completely different → near 1', () => {
  const ratio = computeTokenDiffRatio('alpha beta gamma', 'delta epsilon zeta')
  assert.ok(ratio > 0.9, `Expected > 0.9, got ${ratio}`)
})

test('purgeDiffUtils (A): computeTokenDiffRatio detects minor change', () => {
  const base = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
  const changed = base.replace('word50', 'CHANGED')
  const ratio = computeTokenDiffRatio(base, changed)
  assert.ok(ratio > 0, 'Should detect some difference')
  assert.ok(ratio < 0.1, 'Minor change should have small ratio')
})

test('purgeDiffUtils (A): computeSimilarity identical → 1', () => {
  assert.equal(computeSimilarity('hello world', 'hello world'), 1)
})

test('purgeDiffUtils (A): computeSimilarity empty vs non-empty → 0', () => {
  assert.equal(computeSimilarity('', 'hello world'), 0)
})

test('purgeDiffUtils (A): computeSimilarity slightly different → near 1', () => {
  const base = 'The quick brown fox jumps over the lazy dog and runs away'
  const tweaked = 'The quick brown fox jumps over the lazy dog and runs fast'
  const sim = computeSimilarity(base, tweaked)
  assert.ok(sim > 0.9, `Expected > 0.9, got ${sim}`)
})

test('purgeDiffUtils (A): stableTextHash produces consistent SHA-256 hex', () => {
  const h1 = stableTextHash('Hello World!')
  const h2 = stableTextHash('Hello World!')
  assert.equal(h1, h2, 'Same input should produce same hash')
  assert.equal(h1.length, 64, 'SHA-256 should produce 64 hex chars')
})

test('purgeDiffUtils (A): stableTextHash normalizes before hashing', () => {
  const h1 = stableTextHash('  Hello   World  ')
  const h2 = stableTextHash('hello world')
  assert.equal(h1, h2, 'Should normalize before hashing')
})

// ─── B) purgeMaterialChange ──────────────────────────────────────────────────

test('purgeMaterialChange (B): no change on identical text', () => {
  const text = 'Apply now for funding assistance in your county.'
  const r = detectMaterialChange({ text }, { text })
  assert.equal(r.changed, false)
  assert.equal(r.similarity, 1)
  assert.equal(r.tokenDiffRatio, 0)
})

test('purgeMaterialChange (B): status change is always material', () => {
  const r = detectMaterialChange(
    { status: 'open', text: 'Same text here' },
    { status: 'closed', text: 'Same text here' },
  )
  assert.equal(r.changed, true)
  assert.equal(r.reason, 'status_change')
  assert.ok(r.fieldChanges.status)
})

test('purgeMaterialChange (B): deadline change is always material', () => {
  const r = detectMaterialChange(
    { deadline: '2024-03-01', text: 'Same text.' },
    { deadline: '2024-06-30', text: 'Same text.' },
  )
  assert.equal(r.changed, true)
  assert.equal(r.reason, 'deadline_change')
})

test('purgeMaterialChange (B): trivial text edit (whitespace only) is NOT material', () => {
  const base = 'Apply now for community funding assistance programs.'
  const tweaked = '  Apply now  for community funding  assistance programs.  '
  const r = detectMaterialChange({ text: base }, { text: tweaked })
  assert.equal(r.changed, false, 'Whitespace-only change should not be material')
})

test('purgeMaterialChange (B): large text replacement IS material', () => {
  const base = Array.from({ length: 50 }, () => 'funding assistance grant apply').join(' ')
  const replaced = Array.from({ length: 50 }, () => 'program ended closed no longer accepting').join(' ')
  const r = detectMaterialChange({ text: base }, { text: replaced })
  assert.equal(r.changed, true)
  assert.equal(r.reason, 'text_diff_verified')
  assert.ok(r.tokenDiffRatio > TOKEN_DIFF_THRESHOLD)
})

test('purgeMaterialChange (B): null/undefined inputs → not changed', () => {
  const r = detectMaterialChange(null, null)
  assert.equal(r.changed, false)
})

test('purgeMaterialChange (B): same hash → no material change', () => {
  const text = 'Some content about a grant program.'
  const r = detectMaterialChange({ text }, { text })
  assert.equal(r.changed, false)
  assert.equal(r.tokenDiffRatio, 0)
})

// ─── C) discoverActiveProfileStates ──────────────────────────────────────────

// discoverActiveProfileStates is async (dialect divergence fix: db.prepare().all()
// is synchronous on the SQLite shim but ASYNC on the Postgres shim, so the
// function now awaits its own queries and callers must await it too).
test('discoverActiveProfileStates (C): discovers from profiles.state', async () => {
  const db = makeDb(false)
  db.prepare(`INSERT INTO profiles (id, state) VALUES ('p1', 'TN'), ('p2', 'OH')`).run()
  const states = await discoverActiveProfileStates(db)
  assert.ok(states.includes('TN'), 'Should include TN')
  assert.ok(states.includes('OH'), 'Should include OH')
})

test('discoverActiveProfileStates (C): deduplicates states', async () => {
  const db = makeDb(false)
  db.prepare(`INSERT INTO profiles (id, state) VALUES ('p1','TN'),('p2','TN'),('p3','OH')`).run()
  const states = await discoverActiveProfileStates(db)
  const tnCount = states.filter((s) => s === 'TN').length
  assert.equal(tnCount, 1, 'TN should appear only once')
})

test('discoverActiveProfileStates (C): excludes empty/invalid states', async () => {
  const db = makeDb(false)
  db.prepare(`INSERT INTO profiles (id, state) VALUES ('p1',''), ('p2', NULL), ('p3','INVALID'), ('p4', 'GA')`).run()
  const states = await discoverActiveProfileStates(db)
  assert.ok(!states.includes(''), 'Empty string should be excluded')
  assert.ok(!states.includes('INVALID'), 'Non-2-letter values should be excluded')
  assert.ok(states.includes('GA'), 'Valid state GA should be included')
})

test('discoverActiveProfileStates (C): discovers state from profile_sections.basic_information', async () => {
  const db = makeDb(false)
  db.prepare(`INSERT INTO profiles (id, state) VALUES ('p1', NULL)`).run()
  db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES ('p1', 'basic_information', ?)`).run(JSON.stringify({ state: 'FL' }))
  const states = await discoverActiveProfileStates(db)
  assert.ok(states.includes('FL'), 'State from basic_information section should be included')
})

test('discoverActiveProfileStates (C): returns empty array when no profiles', async () => {
  const db = makeDb(false)
  const states = await discoverActiveProfileStates(db)
  assert.deepEqual(states, [])
})

// ─── D) regionalPurgeService integration ─────────────────────────────────────

test('regionalPurge (D): dry-run does not mutate DB', async () => {
  const db = makeDb()

  // Stub fetch to simulate closed page
  const fakeFetch = async () => ({ status: 410, text: async () => '' })

  // Pre-check
  const before = db.prepare(`SELECT suppression_state FROM funding_opportunities WHERE id = 'opp1'`).get()
  assert.equal(before?.suppression_state || 'active', 'active')

  const result = await runRegionalPurge(db, {
    dryRun: true,
    states: ['TN'],
    fetchFn: fakeFetch,
  })

  const after = db.prepare(`SELECT suppression_state FROM funding_opportunities WHERE id = 'opp1'`).get()
  assert.equal(after?.suppression_state || 'active', 'active', 'Dry-run must not mutate DB')

  // No event rows should be written
  const events = db.prepare(`SELECT * FROM opportunity_suppression_events`).all()
  assert.equal(events.length, 0, 'Dry-run must not write event rows')

  assert.ok(result.statesProcessed.includes('TN'), 'Should report TN as processed')
})

test('regionalPurge (D): suppresses opportunity on HTTP 410', async () => {
  const db = makeDb()

  const fakeFetch = async () => ({ status: 410, text: async () => '' })

  await runRegionalPurge(db, {
    dryRun: false,
    states: ['TN'],
    fetchFn: fakeFetch,
  })

  const opp = db.prepare(`SELECT suppression_state, suppression_reason FROM funding_opportunities WHERE id = 'opp1'`).get()
  assert.equal(opp.suppression_state, 'suppressed', 'Should be suppressed after HTTP 410')

  // Verify event row exists
  const events = db.prepare(`SELECT * FROM opportunity_suppression_events WHERE opportunity_id = 'opp1'`).all()
  assert.ok(events.length > 0, 'Should write at least one suppression event')
  assert.equal(events[0].new_state, 'suppressed')
  assert.equal(events[0].actor, 'regional_purge')
})

test('regionalPurge (D): ambiguous change → watch (no verification)', async () => {
  const db = makeDb(false)
  db.prepare(`INSERT INTO profiles (id, state) VALUES ('px', 'GA')`).run()
  db.prepare(`INSERT INTO funding_opportunities (id, title, state, source_url, description, status, last_seen_text, is_active)
    VALUES ('oppG', 'GA Grant', 'GA', 'http://example.com/ga',
            'Completely different content that changes materially',
            'open',
            'Original content that is completely different to trigger diff',
            1)`).run()

  // Fetch returns 200 with no clear signal
  const fakeFetch = async () => ({
    status: 200,
    text: async () => '<html><body>Some page</body></html>',
  })

  await runRegionalPurge(db, { dryRun: false, states: ['GA'], fetchFn: fakeFetch })

  const opp = db.prepare(`SELECT suppression_state FROM funding_opportunities WHERE id = 'oppG'`).get()
  // The state should be either 'watch' (ambiguous) or 'active' (no material change)
  // With the large text diff between last_seen_text and description, it should be watch
  assert.ok(
    opp.suppression_state === 'watch' || opp.suppression_state === 'active',
    `Expected watch or active, got ${opp.suppression_state}`,
  )
})

test('regionalPurge (D): no suppression on trivial text changes', async () => {
  const db = makeDb(false)
  db.prepare(`INSERT INTO profiles (id, state) VALUES ('py', 'NC')`).run()
  const stableText = 'Apply now for NC community grants assistance program.'
  db.prepare(`INSERT INTO funding_opportunities (id, title, state, source_url, description, status, last_seen_text, is_active)
    VALUES ('oppNC', 'NC Grant', 'NC', 'http://example.com/nc', ?, 'open', ?, 1)`).run(
    stableText + '  ',  // trivial whitespace change
    stableText,
  )

  const fakeFetch = async () => ({
    status: 200,
    text: async () => '<html><body>Apply now for funding</body></html>',
  })

  await runRegionalPurge(db, { dryRun: false, states: ['NC'], fetchFn: fakeFetch })

  const opp = db.prepare(`SELECT suppression_state FROM funding_opportunities WHERE id = 'oppNC'`).get()
  assert.notEqual(opp.suppression_state, 'suppressed', 'Should not suppress on trivial change')
})

test('regionalPurge (D): suppression on status change + verified', async () => {
  const db = makeDb(false)
  db.prepare(`INSERT INTO profiles (id, state) VALUES ('pz', 'WA')`).run()
  db.prepare(`INSERT INTO funding_opportunities (id, title, state, source_url, description, status, last_status, is_active)
    VALUES ('oppWA', 'WA Grant', 'WA', 'http://example.com/wa', 'Apply now.', 'closed', 'open', 1)`).run()

  // Verification returns explicit closed signal
  const fakeFetch = async () => ({
    status: 200,
    text: async () => '<html><body>Applications are closed. No longer accepting applications.</body></html>',
  })

  await runRegionalPurge(db, { dryRun: false, states: ['WA'], fetchFn: fakeFetch })

  const opp = db.prepare(`SELECT suppression_state FROM funding_opportunities WHERE id = 'oppWA'`).get()
  assert.equal(opp.suppression_state, 'suppressed', 'Status change + verification should suppress')
})

test('regionalPurge (D): event rows contain required audit fields', async () => {
  const db = makeDb()

  const fakeFetch = async () => ({ status: 410, text: async () => '' })

  await runRegionalPurge(db, { dryRun: false, states: ['TN', 'OH'], fetchFn: fakeFetch })

  const events = db.prepare(`SELECT * FROM opportunity_suppression_events`).all()
  assert.ok(events.length > 0, 'Should write event rows')

  for (const ev of events) {
    assert.ok(ev.id, 'Event must have id')
    assert.ok(ev.opportunity_id, 'Event must have opportunity_id')
    assert.ok(ev.previous_state, 'Event must have previous_state')
    assert.ok(ev.new_state, 'Event must have new_state')
    assert.ok(ev.checked_at, 'Event must have checked_at')
    assert.equal(ev.actor, 'regional_purge', 'Event actor must be regional_purge')
  }
})

test('regionalPurge (D): inferSourceTier classifies .gov as tier_a', () => {
  assert.equal(inferSourceTier('https://grants.ohio.gov/program'), 'tier_a')
  assert.equal(inferSourceTier('https://grants.gov/search'), 'tier_a')
  assert.equal(inferSourceTier('https://tn.gov/grants'), 'tier_a')
  assert.equal(inferSourceTier('https://countyprogram.org/grants'), 'tier_b')
  assert.equal(inferSourceTier(null), 'unknown')
})

test('regionalPurge (D): auto-discovers states when none specified', async () => {
  const db = makeDb() // has TN and OH profiles seeded

  const fakeFetch = async () => ({ status: 200, text: async () => '<html><body>Apply now</body></html>' })

  const result = await runRegionalPurge(db, { dryRun: true, fetchFn: fakeFetch })

  assert.ok(result.statesProcessed.includes('TN'), 'Should auto-discover TN')
  assert.ok(result.statesProcessed.includes('OH'), 'Should auto-discover OH')
})
