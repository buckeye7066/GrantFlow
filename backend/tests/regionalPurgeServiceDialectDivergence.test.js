/**
 * Dialect-divergence regression test for regionalPurgeService.js (the
 * ingestionService/#946 class, found during a systemic sweep for a 5th
 * instance of this bug family): several functions here called
 * `db.prepare().all()/.get()/.run()` and `db.transaction(fn)()` WITHOUT
 * awaiting them (discoverActiveProfileStates, the runRegionalPurge candidate
 * query, persistSuppressionTransition, getPurgeSummary, getPurgeEvents).
 * better-sqlite3's shim is synchronous so this worked in tests/CI; the
 * Postgres shim's prepare()/exec()/transaction() are ASYNC, so under
 * production every one of these silently returned a pending Promise instead
 * of real data (an empty target-state list, "opportunities is not iterable",
 * a suppression transition that never actually wrote before the caller moved
 * on).
 *
 * This test drives the real, now-async functions through a db double whose
 * run/get/all/exec resolve on a real microtask delay and whose
 * withTransaction uses genuine BEGIN/COMMIT, so an un-awaited call is
 * observable (it would race real data).
 */
import { describe, expect, it, afterEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  discoverActiveProfileStates,
  runRegionalPurge,
  getPurgeSummary,
} from '../services/regionalPurgeService.js'

const SCHEMA = `
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
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    state TEXT
  );
`

function delay() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * A SQLite-backed db handle whose statement methods are genuinely async, and
 * whose transaction()/withTransaction() shapes mirror backend/db/index.js's
 * PostgresDb -- the same simulator style as
 * backend/tests/profileDedupeMergeTransaction.test.js's makePostgresSemanticsDb.
 */
function makeAsyncSemanticsDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(SCHEMA)

  const makeHandle = () => ({
    // dialect stays 'sqlite' -- the bug under test is about run/get/all/exec
    // being ASYNC (what the Postgres shim actually does), not about the
    // isPg boolean/type selection some callers also branch on.
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: async (...args) => { await delay(); return stmt.get(...args) },
        all: async (...args) => { await delay(); return stmt.all(...args) },
        run: async (...args) => { await delay(); return stmt.run(...args) },
      }
    },
    async exec(sql) { await delay(); return sqlite.exec(sql) },
  })

  return {
    ...makeHandle(),
    _sqlite: sqlite,
    async withTransaction(fn) {
      sqlite.exec('BEGIN')
      try {
        const result = await fn(makeHandle())
        await delay()
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        try { sqlite.exec('ROLLBACK') } catch { /* ignore */ }
        throw error
      }
    },
    close() { sqlite.close() },
  }
}

let openDb = null
afterEach(() => {
  if (openDb) { openDb.close(); openDb = null }
})

describe('regionalPurgeService under Postgres-async semantics', () => {
  it('discoverActiveProfileStates awaits its queries and returns real states', async () => {
    const db = makeAsyncSemanticsDb()
    openDb = db
    db._sqlite.prepare("INSERT INTO profiles (id, state) VALUES ('p1', 'TN')").run()
    db._sqlite.prepare("INSERT INTO profiles (id, state) VALUES ('p2', 'OH')").run()

    // Pre-fix, this would have returned [] (every catalog probe threw
    // "not iterable" on the un-awaited Promise and was swallowed by the
    // try/catch), which silently made runRegionalPurge a no-op in prod.
    const states = await discoverActiveProfileStates(db)
    expect(states).toEqual(['OH', 'TN'])
  })

  it('runRegionalPurge auto-discovers states, queries candidates, and persists a real suppression transition', async () => {
    const db = makeAsyncSemanticsDb()
    openDb = db
    db._sqlite.prepare("INSERT INTO profiles (id, state) VALUES ('p1', 'TN')").run()
    db._sqlite.prepare(
      `INSERT INTO funding_opportunities (id, title, state, source_url, description, status, is_active)
       VALUES ('opp1', 'Test Grant TN', 'TN', 'http://example.com/opp1', 'Apply now for funding.', 'open', 1)`
    ).run()

    const fakeFetch = async () => ({ status: 410, text: async () => '' })

    const result = await runRegionalPurge(db, { dryRun: false, fetchFn: fakeFetch })

    // Auto-discovery must have found TN (proves discoverActiveProfileStates
    // was awaited by runRegionalPurge, not treated as truthy garbage).
    expect(result.statesProcessed).toEqual(['TN'])
    expect(result.checked).toBe(1)
    expect(result.suppressed).toBe(1)

    // The write must be visible immediately after the awaited call returns --
    // pre-fix, persistSuppressionTransition's un-awaited transaction() could
    // still be in flight (or have silently failed) at this point.
    const opp = db._sqlite.prepare('SELECT suppression_state FROM funding_opportunities WHERE id = ?').get('opp1')
    expect(opp.suppression_state).toBe('suppressed')

    const events = db._sqlite.prepare('SELECT * FROM opportunity_suppression_events WHERE opportunity_id = ?').all('opp1')
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].new_state).toBe('suppressed')

    // getPurgeSummary must also await its own queries to see the event just written.
    const summary = await getPurgeSummary(db)
    expect(summary.totals.find((t) => t.new_state === 'suppressed')?.cnt).toBeGreaterThan(0)
  })
})