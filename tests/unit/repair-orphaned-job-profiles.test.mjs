/**
 * repair-orphaned-job-profiles.test.mjs
 *
 * Regression for: autonomous scholarship/comprehensive crawler jobs stuck in
 * `failed` with `error = "Snapshot creation failed: Profile profile-X not found"`
 * and `result_meta = { non_retryable: true }`. After the alias-resolver fix
 * (commit f446de41), new dispatches self-heal, but already-dead rows like
 *   - Anastasia: b71c0528-…
 *   - Avanell:   e16c4731-…
 * stay failed until someone clicks Retry. This module repairs them on
 * startup so the run actually finishes (mission rule: zero results is a
 * failure state, not an acceptable outcome).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { repairOrphanedJobProfiles } from '../../backend/utils/repairOrphanedJobProfiles.js'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      section_key TEXT,
      data TEXT,
      updated_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(profile_id, section_key)
    );
    CREATE TABLE profile_tombstones (
      profile_id TEXT PRIMARY KEY,
      deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_by TEXT,
      reason TEXT
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_users (
      profile_id TEXT,
      user_id TEXT,
      role TEXT DEFAULT 'owner',
      PRIMARY KEY(profile_id, user_id)
    );
    CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      profile_id TEXT,
      organization_id TEXT,
      parameters TEXT,
      profile_context_snapshot TEXT,
      idempotency_key TEXT,
      requested_by TEXT,
      error TEXT,
      result_meta TEXT,
      retry_count INTEGER DEFAULT 0,
      last_retry_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      worker_id TEXT
    );
  `)
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: async (...p) => stmt.get(...p),
        all: async (...p) => stmt.all(...p),
        run: async (...p) => {
          const r = stmt.run(...p)
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
        },
      }
    },
    exec(sql) {
      sqlite.exec(sql)
    },
    withTransaction(fn) {
      return fn(this)
    },
    raw: sqlite,
  }
}

function insertJob(db, overrides = {}) {
  const job = {
    id: overrides.id || `job-${Math.random().toString(36).slice(2, 10)}`,
    type: overrides.type || 'comprehensive',
    status: overrides.status || 'failed',
    profile_id: overrides.profile_id ?? null,
    parameters: JSON.stringify(overrides.parameters || { autonomous_run: true }),
    error: overrides.error ?? null,
    result_meta: overrides.result_meta == null ? null : JSON.stringify(overrides.result_meta),
    idempotency_key: overrides.idempotency_key || `idem-${job_idem_counter++}`,
    requested_by: overrides.requested_by || 'system',
  }
  db.raw
    .prepare(
      `INSERT INTO crawler_jobs
       (id, type, status, profile_id, parameters, error, result_meta, idempotency_key, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.id,
      job.type,
      job.status,
      job.profile_id,
      job.parameters,
      job.error,
      job.result_meta,
      job.idempotency_key,
      job.requested_by,
    )
  return job
}
let job_idem_counter = 1

describe('repairOrphanedJobProfiles', () => {
  it('re-keys + re-queues a failed job with stale designated slug profile_id', async () => {
    const db = makeDb()
    // Live profile lives at the UUID, NOT at the slug.
    db.raw
      .prepare(
        `INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, ?, 'active')`,
      )
      .run('uuid-anastasia', 'Anastasia Nicole White', 'high_school_student')

    insertJob(db, {
      id: 'b71c0528-test',
      type: 'scholarship',
      profile_id: 'profile-anastasia-white',
      error: 'Snapshot creation failed: Profile profile-anastasia-white not found',
      result_meta: { non_retryable: true },
    })

    const summary = await repairOrphanedJobProfiles(db, { limit: 50, log: () => {} })
    assert.equal(summary.scanned, 1)
    assert.equal(summary.repaired, 1)
    assert.equal(summary.errors, 0)

    const repaired = db.raw.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get('b71c0528-test')
    assert.equal(repaired.status, 'queued')
    assert.equal(repaired.profile_id, 'uuid-anastasia')
    assert.equal(repaired.error, null)
    assert.equal(repaired.completed_at, null)
    assert.equal(repaired.started_at, null)
    assert.equal(repaired.worker_id, null)

    const meta = JSON.parse(repaired.result_meta)
    assert.equal(meta.non_retryable, false)
    assert.equal(meta.repaired_from_profile_id, 'profile-anastasia-white')
    assert.equal(meta.repaired_to_profile_id, 'uuid-anastasia')
    assert.ok(meta.repaired_at)
    assert.match(meta.repair_strategy, /designated_display_name|reseed/)
    assert.match(repaired.idempotency_key, /^repaired_/)
  })

  it('does NOT touch FK / unrelated failures', async () => {
    const db = makeDb()
    insertJob(db, {
      id: 'fk-fail',
      type: 'comprehensive',
      profile_id: 'some-profile',
      error: 'foreign key constraint violation on crawler_jobs.organization_id',
      result_meta: { non_retryable: true },
    })

    const summary = await repairOrphanedJobProfiles(db, { limit: 50, log: () => {} })
    assert.equal(summary.scanned, 1)
    assert.equal(summary.repaired, 0)
    assert.equal(summary.skipped, 1)

    const row = db.raw.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get('fk-fail')
    assert.equal(row.status, 'failed', 'FK failure must remain failed')
    assert.equal(row.error, 'foreign key constraint violation on crawler_jobs.organization_id')
  })

  it('is idempotent — never repairs the same row twice', async () => {
    const db = makeDb()
    db.raw
      .prepare(
        `INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, ?, 'active')`,
      )
      .run('uuid-avanell', 'Avanell Lea Leamon', 'family')

    insertJob(db, {
      id: 'e16c4731-test',
      type: 'comprehensive',
      profile_id: 'profile-avanell-leamon',
      error: 'Snapshot creation failed: Profile profile-avanell-leamon not found',
      result_meta: { non_retryable: true },
    })

    const first = await repairOrphanedJobProfiles(db, { limit: 50, log: () => {} })
    assert.equal(first.repaired, 1)

    // Even if the row drops back to `failed` later (e.g. transient runtime
    // error in the next run), the repair flag must stop us from repairing
    // again.
    db.raw.prepare(`UPDATE crawler_jobs SET status='failed', error='Snapshot creation failed: Profile profile-avanell-leamon not found' WHERE id = 'e16c4731-test'`).run()

    const second = await repairOrphanedJobProfiles(db, { limit: 50, log: () => {} })
    assert.equal(second.scanned, 1)
    assert.equal(second.repaired, 0, 'repaired_at audit flag must prevent double repair')
    assert.equal(second.skipped, 1)
  })

  it('skips orphaned rows when no live profile can be resolved', async () => {
    const db = makeDb()
    insertJob(db, {
      id: 'orphan-1',
      type: 'scholarship',
      profile_id: 'totally-random-id-not-in-config',
      error: 'Snapshot creation failed: Profile totally-random-id-not-in-config not found',
      result_meta: { non_retryable: true },
    })

    const summary = await repairOrphanedJobProfiles(db, { limit: 50, log: () => {} })
    assert.equal(summary.scanned, 1)
    assert.equal(summary.repaired, 0)
    assert.equal(summary.skipped, 1)

    const row = db.raw.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get('orphan-1')
    assert.equal(row.status, 'failed', 'unresolvable orphan must stay failed')
  })

  it('handles missing crawler_jobs table without throwing', async () => {
    const sqlite = new Database(':memory:')
    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        const stmt = sqlite.prepare(sql)
        return {
          get: async (...p) => stmt.get(...p),
          all: async (...p) => stmt.all(...p),
          run: async (...p) => {
            const r = stmt.run(...p)
            return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
          },
        }
      },
    }

    const summary = await repairOrphanedJobProfiles(db, { limit: 5, log: () => {} })
    assert.equal(summary.scanned, 0)
    assert.equal(summary.repaired, 0)
  })
})
