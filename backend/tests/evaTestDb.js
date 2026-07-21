// Shared test helper: a fresh in-memory SQLite DB with the EVA tables, wrapped
// in the minimal db.prepare().run/get/all shim the EVA services expect.
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, '..', 'db', 'schema.sql')

export function makeEvaDb() {
  const sqlite = new Database(':memory:')
  const schema = readFileSync(SCHEMA_PATH, 'utf8')
  // Only the EVA tables are needed for these tests.
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS eva_runs')
  sqlite.exec(schema.slice(start))
  const db = {
    dialect: 'sqlite',
    _sqlite: sqlite,
    prepare(sql) {
      const st = sqlite.prepare(sql)
      return {
        run: (...a) => st.run(...a),
        get: (...a) => st.get(...a),
        all: (...a) => st.all(...a),
      }
    },
    // Mirrors the GrantFlow shim's withTransaction: runs fn with a connection
    // that has the same .prepare surface, committing on success / rolling back on
    // throw. better-sqlite3 is synchronous, so we bracket with BEGIN/COMMIT.
    async withTransaction(fn) {
      sqlite.exec('BEGIN')
      try {
        const result = await fn(db)
        sqlite.exec('COMMIT')
        return result
      } catch (err) {
        try {
          sqlite.exec('ROLLBACK')
        } catch {
          /* ignore */
        }
        throw err
      }
    },
    close() {
      sqlite.close()
    },
  }
  return db
}
