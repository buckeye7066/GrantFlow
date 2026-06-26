import Database from 'better-sqlite3'
import { normalizeSqliteArgs } from '../../backend/db/index.js'

// Production-faithful SQLite wrapper for unit tests.
//
// The real `backend/db` SQLite adapter runs every bound parameter through
// normalizeSqliteArgs (booleans -> 1/0, Date -> ISO string, objects/arrays ->
// JSON) before handing it to better-sqlite3. Hand-rolled test wrappers that
// call `stmt.run(...p)` directly skip that step, so a value the production
// adapter happily coerces — e.g. a real boolean bound to a Postgres BOOLEAN
// column — throws "SQLite3 can only bind numbers, strings, bigints, buffers,
// and null" only in CI. That divergence is a false failure (or, worse, a
// missed real bug). Every test MUST build its db through this helper so the
// test path matches production exactly.
export function wrapSqlite(sqlite) {
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: async (...p) => stmt.get(...normalizeSqliteArgs(p)),
        all: async (...p) => stmt.all(...normalizeSqliteArgs(p)),
        run: async (...p) => {
          const r = stmt.run(...normalizeSqliteArgs(p))
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
        },
      }
    },
    exec(sql) { sqlite.exec(sql) },
    // The production adapter exposes withTransaction(fn) where `fn` receives a
    // tx handle that shares the same prepare()/run() surface. better-sqlite3's
    // native transaction() cannot wrap an async callback, so for tests we run
    // the callback against this same wrapper — matching the contract callers
    // rely on (tx.prepare(...).run(...)) without needing real nesting.
    async withTransaction(fn) {
      return fn(this)
    },
    raw: sqlite,
  }
}

// Convenience: open an in-memory db, optionally exec a schema, and wrap it.
export function createSqliteTestDb(schema = null) {
  const sqlite = new Database(':memory:')
  if (schema) sqlite.exec(schema)
  return wrapSqlite(sqlite)
}
