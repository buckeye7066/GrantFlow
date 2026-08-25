/**
 * crawler.sourcePersistentFailure — the per-source dead-endpoint detector.
 *
 * The fleet-average check (crawler.coverageDegraded) structurally cannot see
 * ONE source failing 100% of its runs inside a healthy fleet — 5 failures in
 * 50 runs is 10%, under every threshold — so a rotted registry URL or expired
 * key decayed silently while Amy's cohort reported anonymous
 * source_fetch_failed findings. This check names the source and its error.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { DIAGNOSTIC_CHECKS } from '../services/sam/samRegistry.js'

const check = DIAGNOSTIC_CHECKS.find((c) => c.id === 'crawler.sourcePersistentFailure')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE crawler_source_runs (
    crawler_run_id TEXT, profile_id TEXT, crawler_type TEXT,
    source_id TEXT, source_label TEXT,
    planned INTEGER, queried INTEGER, failed INTEGER, found INTEGER,
    directory INTEGER, error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`)
  db.dialect = 'sqlite'
  return db
}

// findPersistentlyFailingSources bounds its query to a recency window
// (default 14d, gf-batch-02) so a retired/unqueried source cannot red this
// check forever. Fixtures must therefore be dated relative to NOW, never to
// a hardcoded calendar date — a fixed '2026-07-2X' date silently ages out of
// the window as real time passes, which is exactly what broke this file.
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
const hoursAgo = (n) => new Date(Date.now() - n * 60 * 60 * 1000).toISOString()

const seed = (db, { source = 'tn_state_portal', failed = 1, error = null, at = daysAgo(0), queried = 1 } = {}) =>
  db.prepare(
    `INSERT INTO crawler_source_runs (crawler_run_id, source_id, source_label, planned, queried, failed, found, directory, error, created_at)
     VALUES ('run', ?, ?, 1, ?, ?, 0, 0, ?, ?)`,
  ).run(source, source, queried, failed, error, at)

describe('crawler.sourcePersistentFailure', () => {
  it('is registered', () => {
    expect(check).toBeTruthy()
  })

  it('names a source whose last N queried runs ALL failed — invisible to the fleet average', async () => {
    const db = makeDb()
    // 5 consecutive failures on one source (100%)…
    for (let i = 0; i < 5; i++) seed(db, { failed: 1, error: 'ENOTFOUND portal.example.gov', at: daysAgo(i) })
    // …drowned in 45 healthy runs from other sources (fleet rate 10%).
    for (let i = 0; i < 45; i++) seed(db, { source: `healthy_${i % 9}`, failed: 0, at: daysAgo(i % 5) })
    const res = await check.run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('tn_state_portal')
    expect(res.summary).toContain('ENOTFOUND')
    expect(res.evidence.sources[0].source_id).toBe('tn_state_portal')
  })

  it('stays green when the streak is broken by a success (transient noise, the ×2 cohort class)', async () => {
    const db = makeDb()
    for (let i = 0; i < 4; i++) seed(db, { failed: 1, at: daysAgo(i + 1) })
    seed(db, { failed: 0, at: daysAgo(0) }) // one success, most recent — inside the window
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
  })

  it('does not backfill older failures when the latest-N streak contains an external block', async () => {
    const db = makeDb()
    // Five genuine older failures would form a streak only if the detector
    // incorrectly filtered this newest row BEFORE assigning row numbers.
    for (let i = 1; i <= 5; i++) {
      seed(db, { failed: 1, error: 'ECONNRESET portal.example.gov', at: hoursAgo(i) })
    }
    seed(db, {
      failed: 1,
      error: '  EXTERNAL_BLOCKED:upstream_maintenance',
      at: hoursAgo(0),
    })

    const res = await check.run({ db })
    expect(res.ok).toBe(true)
  })

  it('stays green for a source with too few queried runs (no reliable signal yet)', async () => {
    const db = makeDb()
    for (let i = 0; i < 3; i++) seed(db, { failed: 1, at: daysAgo(i) })
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
  })

  it('ignores never-queried (skipped) rows and fails open without the table', async () => {
    const db = makeDb()
    for (let i = 0; i < 5; i++) seed(db, { failed: 1, queried: 0, at: daysAgo(i) })
    expect((await check.run({ db })).ok).toBe(true)
    const bare = new Database(':memory:')
    bare.dialect = 'sqlite'
    expect((await check.run({ db: bare })).ok).toBe(true)
  })
})
