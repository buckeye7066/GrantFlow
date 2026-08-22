/**
 * crawler.sourceAdapterUrlDefect — the adapter-URL-defect blind spot.
 *
 * A source can run cleanly (failed=false), fetch its feed, parse candidates,
 * and still store NOTHING because the reality gate rejects every candidate as
 * `bad_url` (an adapter emitting an http:// or malformed URL). Every existing
 * crawler check keys on `failed` or `api_outage`, so this class was invisible —
 * `nih_guide` fed http:// links and silently returned zero for research orgs.
 * This detector + check names the source and routes it as an ADAPTER CODE fix,
 * matched on `bad_url` alone so intentional gate exclusions and external
 * outages never trip it.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { DIAGNOSTIC_CHECKS } from '../services/sam/samRegistry.js'
import { findSourcesRejectingAllUrls } from '../services/sources/sourceFailureDetector.js'

const check = DIAGNOSTIC_CHECKS.find((c) => c.id === 'crawler.sourceAdapterUrlDefect')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE crawler_source_runs (
    crawler_run_id TEXT, profile_id TEXT, crawler_type TEXT,
    source_id TEXT, source_label TEXT,
    planned INTEGER, queried INTEGER, failed INTEGER, found INTEGER,
    directory INTEGER, error TEXT, parsed_candidates INTEGER, rejected INTEGER,
    accepted INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`)
  db.dialect = 'sqlite'
  return db
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

const seed = (db, { source = 'nih_guide', failed = 0, found = 0, rejected = 3, error = 'all_candidates_rejected:bad_url', at = daysAgo(0), queried = 1 } = {}) =>
  db.prepare(
    `INSERT INTO crawler_source_runs (crawler_run_id, source_id, source_label, planned, queried, failed, found, directory, error, parsed_candidates, rejected, accepted, created_at)
     VALUES ('run', ?, ?, 1, ?, ?, ?, 0, ?, ?, ?, 0, ?)`,
  ).run(source, source, queried, failed, found, error, rejected, rejected, at)

describe('crawler.sourceAdapterUrlDefect', () => {
  it('is registered', () => {
    expect(check).toBeTruthy()
  })

  it('flags a source whose recent runs ALL reject every candidate as bad_url (failed=false)', async () => {
    const db = makeDb()
    for (let i = 0; i < 3; i++) seed(db, { source: 'nih_guide', at: daysAgo(i) })
    const res = await check.run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('nih_guide')
    expect(res.recommended_fix).toMatch(/adapter/i)
  })

  it('does NOT flag a genuine FETCH failure (failed=true) — that is the sibling check', async () => {
    const db = makeDb()
    for (let i = 0; i < 3; i++) seed(db, { source: 'dead_endpoint', failed: 1, rejected: 0, error: 'ENOTFOUND', at: daysAgo(i) })
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
  })

  it('does NOT flag an intentional gate exclusion (no_sponsor) — matched on bad_url alone', async () => {
    const db = makeDb()
    for (let i = 0; i < 3; i++) seed(db, { source: 'sam_gov', error: 'all_candidates_rejected:no_sponsor', at: daysAgo(i) })
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
  })

  it('does NOT flag a source that recovers (one recent run stored a result)', async () => {
    const db = makeDb()
    seed(db, { source: 'nih_guide', found: 5, rejected: 0, error: null, at: daysAgo(0) }) // newest: healthy
    seed(db, { source: 'nih_guide', at: daysAgo(1) })
    seed(db, { source: 'nih_guide', at: daysAgo(2) })
    const res = await check.run({ db })
    expect(res.ok).toBe(true)
  })

  it('detector is empty for a clean fleet', async () => {
    const db = makeDb()
    for (let i = 0; i < 5; i++) seed(db, { source: `ok_${i}`, found: 4, rejected: 0, error: null, at: daysAgo(i) })
    expect(await findSourcesRejectingAllUrls(db, { streak: 3 })).toHaveLength(0)
  })
})
