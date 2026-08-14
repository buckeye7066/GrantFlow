/**
 * Dialect-divergence regression test (the crawlerV2.js `?.count` precedence
 * class): `backend/startup/selfHeal.js`'s faith-based-housing and
 * housing-funding seed checks did
 *
 *   const faithCount = db.prepare(sql).get()?.count ?? 0
 *
 * without awaiting `.get()`. better-sqlite3's `.get()` is synchronous so this
 * worked locally/CI; the Postgres shim's `.get()` is ASYNC, so `.get()?.count`
 * read `.count` off a pending Promise (always undefined) and `faithCount`/
 * `housingCount` were ALWAYS 0 -- meaning the seeder ran on every single boot
 * under Postgres/production, not only when the table was genuinely short.
 * (Unlike the assistance-directory seeder a few lines above these two blocks,
 * neither is gated behind `db.dialect !== 'sqlite'`, so this was reachable in
 * prod.)
 *
 * This test drives the real runSelfHealOnDemand() through a db double whose
 * prepare().get() resolves on a real microtask delay, proving the count is
 * read correctly (and the seeder is skipped once the table already has
 * enough rows) instead of racing a pending Promise.
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { runSelfHealOnDemand } from '../startup/selfHeal.js'

const SCHEMA_SQL = fs.readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql'),
  'utf8',
)

function delay() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Wraps a real (fast, synchronous) better-sqlite3 handle so every
 * prepare().get()/.all()/.run() resolves on a real microtask delay --
 * mirroring the Postgres shim's async prepare(), while keeping the actual
 * SQL execution against a real, fully-schema'd SQLite db.
 */
function makeAsyncSemanticsDb() {
  const raw = new Database(':memory:')
  raw.exec(SCHEMA_SQL)

  const wrapped = {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: async (...args) => { await delay(); return stmt.get(...args) },
        all: async (...args) => { await delay(); return stmt.all(...args) },
        run: async (...args) => { await delay(); return stmt.run(...args) },
      }
    },
    exec(sql) { return raw.exec(sql) },
    withTransaction: (fn) => fn(wrapped),
    _raw: raw,
  }
  return wrapped
}

let openDb = null
afterEach(() => {
  if (openDb) { openDb._raw.close(); openDb = null }
})

describe('selfHeal seeding counts under Postgres-async db.prepare().get()', () => {
  it('does not re-seed faith-based housing when the table already has enough real rows', async () => {
    const db = makeAsyncSemanticsDb()
    openDb = db

    // Seed 6 real faith_based_assistance rows directly (>= the threshold),
    // bypassing the seeder itself.
    const insert = db._raw.prepare(
      `INSERT INTO funding_opportunities (id, title, source, is_active, state)
       VALUES (?, ?, 'faith_based_assistance', 1, 'OH')`
    )
    for (let i = 0; i < 6; i++) insert.run(`faith-${i}`, `Faith Housing ${i}`)

    await runSelfHealOnDemand(db)

    // Pre-fix, the un-awaited `.get()?.count` was always undefined -> 0,
    // so the seeder would have run anyway and inserted MORE rows past the 6
    // real ones. Post-fix, the count is read correctly and no extra rows
    // should be added by the faith-based seeder.
    const count = db._raw.prepare(
      `SELECT COUNT(*) AS n FROM funding_opportunities WHERE source = 'faith_based_assistance'`
    ).get().n
    expect(count).toBe(6)
  })
})