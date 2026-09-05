/**
 * REGRESSION: SQLite ignores PRAGMA foreign_keys changes made inside an open
 * transaction. The crawler_jobs.type CHECK rebuild used to BEGIN then set
 * foreign_keys=OFF — which was a no-op — so DROP TABLE crawler_jobs CASCADE-
 * deleted crawler_logs / dead_letter_queue rows. This test proves child rows
 * survive a real rebuild when FKs start ON (the production SqliteDb default).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureCrawlerJobsTypeCheckSqlite,
  __testables,
} from '../startup/ensureSchemaInvariants.js'

const { CRAWLER_JOB_TYPES } = __testables

function wrapSqlite(raw) {
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...a) => stmt.get(...a),
        all: (...a) => stmt.all(...a),
        run: (...a) => stmt.run(...a),
      }
    },
    exec(sql) {
      return raw.exec(sql)
    },
  }
}

function seedStaleCrawlerJobsDb() {
  const raw = new Database(':memory:')
  raw.pragma('foreign_keys = ON')
  // Deliberately stale CHECK — missing modern types so the boot repair fires.
  raw.exec(`
    CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('local', 'scholarship', 'national')),
      status TEXT
    );
    CREATE TABLE crawler_logs (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES crawler_jobs(id) ON DELETE CASCADE,
      message TEXT
    );
    CREATE TABLE dead_letter_queue (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      error_message TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES crawler_jobs(id) ON DELETE CASCADE
    );
    INSERT INTO crawler_jobs (id, type, status) VALUES ('job-1', 'local', 'completed');
    INSERT INTO crawler_logs (id, job_id, message) VALUES ('log-1', 'job-1', 'kept');
    INSERT INTO dead_letter_queue (id, job_id, job_type, error_message)
      VALUES ('dlq-1', 'job-1', 'local', 'kept');
  `)
  expect(raw.pragma('foreign_keys', { simple: true })).toBe(1)
  return raw
}

describe('ensureCrawlerJobsTypeCheckSqlite preserves CASCADE children', () => {
  it('keeps crawler_logs and dead_letter_queue rows across the CHECK rebuild', async () => {
    const raw = seedStaleCrawlerJobsDb()
    const db = wrapSqlite(raw)

    const ok = await ensureCrawlerJobsTypeCheckSqlite(db, { logger: { info() {}, warn() {} } })
    expect(ok).toBe(true)

    const ddl = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='crawler_jobs'`).get().sql
    // Repair actually ran: a previously-missing modern type is now in the CHECK.
    expect(CRAWLER_JOB_TYPES).toContain('live_search')
    expect(ddl).toContain(`'live_search'`)

    expect(raw.prepare(`SELECT COUNT(*) AS n FROM crawler_jobs`).get().n).toBe(1)
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM crawler_logs`).get().n).toBe(1)
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM dead_letter_queue`).get().n).toBe(1)
    expect(raw.prepare(`SELECT message FROM crawler_logs WHERE id='log-1'`).get().message).toBe('kept')
    expect(raw.prepare(`SELECT error_message FROM dead_letter_queue WHERE id='dlq-1'`).get().error_message).toBe('kept')

    // FK enforcement must be restored after the rebuild.
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1)
  })
})
