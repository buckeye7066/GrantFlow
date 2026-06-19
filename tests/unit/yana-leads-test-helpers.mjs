/**
 * Test helper: real in-memory SQLite database for the Yana lead pipeline's unit tests.
 *
 * Uses better-sqlite3 in `:memory:` mode and applies the lead pipeline's migration so the
 * tests run against the actual schema, not a hand-built mock. The wrapper
 * exposes the same async-shaped `prepare(sql).run/get/all` surface that the
 * Yana lead-pipeline run store expects (better-sqlite3 itself is synchronous; awaiting a
 * synchronous value resolves to the value, so the run store works either
 * way).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')

function loadMigrationSql() {
  const sqlitePath = path.join(REPO_ROOT, 'backend', 'db', 'migrations', '082_larry_tables.sql')
  return fs.readFileSync(sqlitePath, 'utf8')
}

function normalizeArgs(args) {
  // Mirror the wrapper in backend/db/index.js: stringify object/array params
  // so JSONB-style payloads round-trip even when callers forget to call
  // JSON.stringify themselves.
  return args.map((value) => {
    if (value && (typeof value === 'object') && !Array.isArray(value) && !Buffer.isBuffer(value)) {
      try {
        return JSON.stringify(value)
      } catch {
        return null
      }
    }
    if (Array.isArray(value)) {
      try {
        return JSON.stringify(value)
      } catch {
        return null
      }
    }
    if (typeof value === 'boolean') return value ? 1 : 0
    return value
  })
}

export function createInMemoryDb() {
  const raw = new Database(':memory:')
  raw.pragma('journal_mode = MEMORY')
  raw.pragma('foreign_keys = ON')

  const sql = loadMigrationSql()
  raw.exec(sql)

  // Each prepared statement is wrapped to:
  //   - normalize object/array params into JSON strings
  //   - return a thenable-friendly value (already-resolved sync result)
  const wrapper = {
    dialect: 'sqlite',
    prepare(sqlText) {
      const stmt = raw.prepare(sqlText)
      return {
        run: (...args) => stmt.run(...normalizeArgs(args)),
        get: (...args) => stmt.get(...normalizeArgs(args)),
        all: (...args) => stmt.all(...normalizeArgs(args)),
      }
    },
    exec(sqlText) {
      return raw.exec(sqlText)
    },
    close() {
      raw.close()
    },
    raw,
  }
  return wrapper
}
