/**
 * Golden-amount sentinel (`coverage.goldenAmounts`) — owner-verified per-award
 * figures must never silently regress to a program total or a wrong number (the
 * Coca-Cola $237,500-for-a-$20,000-award class: the extractor grabbed an
 * aggregate, inflating a client's Pipeline Potential 12×, with nobody noticing
 * until the amount was audited by hand).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { getCheckById } from '../services/sam/samRegistry.js'

const KV_KEY = 'golden_amount_expectations'
const check = getCheckById('coverage.goldenAmounts')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, created_by TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, source_url TEXT, amount_min REAL, amount_max REAL);
    CREATE TABLE grants (id TEXT PRIMARY KEY, status TEXT, profile_id TEXT, funding_opportunity_id TEXT,
                         url TEXT, application_url TEXT, amount_requested REAL, amount_min REAL, amount_max REAL);
  `)
  db.prepare("INSERT INTO profiles (id, created_by) VALUES ('real-1', 'user')").run()
  db.prepare("INSERT INTO profiles (id, created_by) VALUES ('amy-1', 'agent:amy')").run()
  return db
}

const putExpectations = (db, payload) =>
  db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(KV_KEY, JSON.stringify(payload), 'x')

const seedGrant = (db, { id = 'g1', url = 'https://coca-colascholarsfoundation.org/apply/', amount = null, profileId = 'real-1' } = {}) =>
  db.prepare("INSERT INTO grants (id, status, profile_id, url, amount_max) VALUES (?, 'interested', ?, ?, ?)")
    .run(id, profileId, url, amount)

const COKE = [{ label: 'Coca-Cola Scholars', url_contains: 'coca-colascholarsfoundation', expect_max: 20000 }]

describe('sam check coverage.goldenAmounts', () => {
  it('is a non-heavy internal check with high severity', () => {
    expect(check).toBeTruthy()
    expect(check.kind).toBe('internal')
    expect(check.heavy).toBeFalsy()
    expect(check.severityOnFailure).toBe('high')
  })

  it('fails open with no db, and skips green when no expectations recorded', async () => {
    expect((await check.run({})).ok).toBe(true)
    const db = makeDb()
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
    expect(res.skipped).toBe(true)
    db.close()
  })

  it('holds GREEN when the real per-award figure is present ($20,000)', async () => {
    const db = makeDb()
    seedGrant(db, { amount: 20000 })
    putExpectations(db, COKE)
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
    db.close()
  })

  it('REDS when the figure regresses to a program total ($237,500)', async () => {
    // THE REGRESSION THIS EXISTS TO CATCH.
    const db = makeDb()
    seedGrant(db, { amount: 237500 })
    putExpectations(db, COKE)
    const res = await check.run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/GOLDEN AMOUNT REGRESSION/)
    expect(res.summary).toMatch(/237,500/)
    expect(res.evidence.failures[0]).toMatchObject({ expect_max: 20000, found: [237500] })
    db.close()
  })

  it('REDS on a wildly-low regression too (under-read)', async () => {
    const db = makeDb()
    seedGrant(db, { amount: 500 }) // $500 vs $20,000 expected, below band ($4,000)
    putExpectations(db, COKE)
    expect((await check.run({ db })).ok).toBe(false)
    db.close()
  })

  it('a grant with NO amount yet is BACKLOG, not a failure', async () => {
    const db = makeDb()
    seedGrant(db, { amount: null })
    putExpectations(db, COKE)
    expect((await check.run({ db })).ok).toBe(true)
    db.close()
  })

  it('ignores Amy synthetic-profile grants', async () => {
    const db = makeDb()
    seedGrant(db, { amount: 237500, profileId: 'amy-1' })
    putExpectations(db, COKE)
    expect((await check.run({ db })).ok).toBe(true)
    db.close()
  })

  it('matches the figure on a LINKED catalog row too', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO funding_opportunities (id, source_url, amount_max) VALUES ('fo1', 'https://coca-colascholarsfoundation.org/apply/', 237500)").run()
    db.prepare("INSERT INTO grants (id, status, profile_id, funding_opportunity_id) VALUES ('g1', 'interested', 'real-1', 'fo1')").run()
    putExpectations(db, COKE)
    expect((await check.run({ db })).ok).toBe(false)
    db.close()
  })

  it('respects a custom over_factor band', async () => {
    const db = makeDb()
    seedGrant(db, { amount: 50000 }) // 2.5× $20,000
    putExpectations(db, [{ label: 'x', url_contains: 'coca-cola', expect_max: 20000, over_factor: 2 }])
    expect((await check.run({ db })).ok).toBe(false) // 50k > 20k*2
    putExpectations(db, [{ label: 'x', url_contains: 'coca-cola', expect_max: 20000, over_factor: 3 }])
    expect((await check.run({ db })).ok).toBe(true) // 50k < 20k*3
    db.close()
  })
})
