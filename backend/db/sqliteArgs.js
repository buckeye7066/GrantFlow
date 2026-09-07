/**
 * sqliteArgs.js — bound-parameter normalization for better-sqlite3.
 *
 * SIDE-EFFECT FREE ON PURPOSE. `backend/db/index.js` re-exports these, but it
 * also opens the application database at import time (`export const db =
 * getDb()`). Anything that only needs the normalizer — the test helper
 * `tests/helpers/sqliteTestDb.mjs` above all — must import from HERE, not from
 * index.js: importing index.js from a dozen parallel Vitest workers opened the
 * real `backend/data/grantflow.db` under WAL concurrently and produced
 * "SqliteError: disk I/O error" (2026-09-07, hamiltonBotBypassRegistry.test.js).
 */

export function normalizeSqliteValue(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  // better-sqlite3 cannot bind objects/arrays; stringify for TEXT/JSON columns.
  // (Buffers are handled by SQLite directly; Dates handled above.)
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return value
}

export function normalizeSqliteArgs(args) {
  if (args.length === 1 && Array.isArray(args[0])) {
    return [args[0].map(normalizeSqliteValue)]
  }
  if (
    args.length === 1 &&
    args[0] &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0]) &&
    !(args[0] instanceof Date) &&
    !Buffer.isBuffer(args[0])
  ) {
    const bindings = args[0]
    const normalized = {}
    for (const [key, val] of Object.entries(bindings)) {
      normalized[key] = normalizeSqliteValue(val)
    }
    return [normalized]
  }
  return args.map(normalizeSqliteValue)
}
