/**
 * Unit tests for the persistent SERP cache (services/shared/webSearchCache.js)
 * — the structural load-reducer that stops the nightly fan-out from
 * re-suspending SearXNG's upstream engines.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { getCachedSearch, putCachedSearch, _resetWebSearchCacheForTests, CACHE_TABLE } from '../services/shared/webSearchCache.js'

function makeDb() {
  const sqlite = new Database(':memory:')
  return {
    _sqlite: sqlite,
    prepare(sql) {
      const st = sqlite.prepare(sql)
      return {
        run: (...a) => st.run(...a),
        get: (...a) => st.get(...a),
        all: (...a) => st.all(...a),
      }
    },
  }
}

const RESULTS = [
  { url: 'https://county.gov/scholarship', title: 'Bradley County Scholarship', snippet: 'apply' },
  { url: 'https://foundation.org/grants', title: 'Foundation Grants', snippet: 'local' },
]

let db
beforeEach(() => {
  db = makeDb()
  _resetWebSearchCacheForTests()
  delete process.env.WEB_SEARCH_CACHE_TTL_HOURS
})
afterEach(() => {
  delete process.env.WEB_SEARCH_CACHE_TTL_HOURS
  _resetWebSearchCacheForTests()
})

describe('webSearchCache', () => {
  it('round-trips a healthy result set and slices to count', async () => {
    expect(await putCachedSearch('Bradley County scholarship', RESULTS, { db })).toBe(true)
    const hit = await getCachedSearch('Bradley County scholarship', { db, count: 1 })
    expect(hit).toEqual([RESULTS[0]])
  })

  it('normalizes the query key (case + whitespace)', async () => {
    await putCachedSearch('Bradley  County   scholarship', RESULTS, { db })
    const hit = await getCachedSearch('  bradley county SCHOLARSHIP ', { db })
    expect(hit?.length).toBe(2)
  })

  it('expires entries past the TTL', async () => {
    const t0 = Date.parse('2026-07-28T00:00:00Z')
    await putCachedSearch('q', RESULTS, { db, now: () => t0 })
    const fresh = await getCachedSearch('q', { db, now: () => t0 + 19 * 3600 * 1000 })
    expect(fresh?.length).toBe(2)
    const staleHit = await getCachedSearch('q', { db, now: () => t0 + 21 * 3600 * 1000 })
    expect(staleHit).toBeNull()
  })

  it('never caches an empty set and never returns one', async () => {
    expect(await putCachedSearch('q', [], { db })).toBe(false)
    expect(await getCachedSearch('q', { db })).toBeNull()
  })

  it('WEB_SEARCH_CACHE_TTL_HOURS=0 disables both read and write', async () => {
    process.env.WEB_SEARCH_CACHE_TTL_HOURS = '0'
    expect(await putCachedSearch('q', RESULTS, { db })).toBe(false)
    expect(await getCachedSearch('q', { db })).toBeNull()
  })

  it('a broken db is a silent miss, never a throw', async () => {
    const broken = { prepare() { throw new Error('boom') } }
    expect(await getCachedSearch('q', { db: broken })).toBeNull()
    expect(await putCachedSearch('q', RESULTS, { db: broken })).toBe(false)
  })

  it('an update refreshes an existing row instead of duplicating it', async () => {
    await putCachedSearch('q', RESULTS, { db })
    await putCachedSearch('q', [RESULTS[1]], { db })
    const n = db._sqlite.prepare(`SELECT COUNT(*) AS n FROM ${CACHE_TABLE}`).get().n
    expect(n).toBe(1)
    const hit = await getCachedSearch('q', { db })
    expect(hit).toEqual([RESULTS[1]])
  })

  it('prunes expired rows on write so the table stays bounded', async () => {
    const t0 = Date.parse('2026-07-28T00:00:00Z')
    await putCachedSearch('old-query', RESULTS, { db, now: () => t0 })
    await putCachedSearch('new-query', RESULTS, { db, now: () => t0 + 25 * 3600 * 1000 })
    const rows = db._sqlite.prepare(`SELECT query_key FROM ${CACHE_TABLE}`).all().map((r) => r.query_key)
    expect(rows).toEqual(['new-query'])
  })
})
