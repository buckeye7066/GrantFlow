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

const seed = (db, { source = 'tn_state_portal', failed = 1, error = null, at = '2026-07-25T00:00:00Z', queried = 1 } = {}) =>
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
    for (let i = 0; i < 5; i++) seed(db, { failed: 1, error: 'ENOTFOUND portal.example.gov', at: `2026-07-2${i}T00:00:00Z` })
    // …drowned in 45 healthy runs from other sources (fleet rate 10%).
    for (let i = 0; i < 45; i++) seed(db, { source: `healthy_${i % 9}`, failed: 0, at: `2026-07-2${i % 5}T01:00:00Z` })
    const res = await check.run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('tn_state_portal')
    expect(res.summary).toContain('ENOTFOUND')
    expect(res.evidence.sources[0].source_id).toBe('tn_state_portal')
  })

  it('stays green when the streak is broken by a success (transient noise, the ×2 cohort class)', async () => {
    const db = makeDb()
    for (let i = 0; i < 4; i++) seed(db, { failed: 1, at: `2026-07-2${i}T00:00:00Z` })
    seed(db, { failed: 0, at: '2026-07-25T00:00:00Z' }) // one success inside the window
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
  })

  it('stays green for a source with too few queried runs (no reliable signal yet)', async () => {
    const db = makeDb()
    for (let i = 0; i < 3; i++) seed(db, { failed: 1, at: `2026-07-2${i}T00:00:00Z` })
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
  })

  it('ignores never-queried (skipped) rows and fails open without the table', async () => {
    const db = makeDb()
    for (let i = 0; i < 5; i++) seed(db, { failed: 1, queried: 0, at: `2026-07-2${i}T00:00:00Z` })
    expect((await check.run({ db })).ok).toBe(true)
    const bare = new Database(':memory:')
    bare.dialect = 'sqlite'
    expect((await check.run({ db: bare })).ok).toBe(true)
  })
})
