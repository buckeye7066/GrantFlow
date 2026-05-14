import { test } from 'node:test'
import assert from 'node:assert/strict'

// Regression test for anyaHealthService.js orphan-cleanup logic.
//
// Before this fix the cleanup unconditionally killed any RUNNING crawler_jobs
// row older than 2h, which murdered a healthy 2h13m geo crawl that was
// actively heartbeating + walking real progress. The new logic should:
//   1. Keep a long-running RUNNING job alive when its last_heartbeat_at is
//      recent (within 10 minutes), regardless of total age.
//   2. Mark a RUNNING job failed when its heartbeat is older than 10 minutes.
//   3. Mark a RUNNING job failed when it never heartbeated AND it is >2h old.
//   4. Mark a QUEUED job failed when it has been stuck >2h.
//   5. Leave a fresh QUEUED job alone.
//
// This test uses an in-memory better-sqlite3 DB shaped like our crawler_jobs
// table and runs the EXACT SQL the service emits for the SQLite dialect.

import Database from 'better-sqlite3'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      created_at DATETIME,
      started_at DATETIME,
      last_heartbeat_at DATETIME,
      completed_at DATETIME,
      error TEXT
    );
  `)
  return db
}

const ORPHAN_CLEANUP_SQL_SQLITE = `UPDATE crawler_jobs
   SET status = 'failed',
       completed_at = datetime('now'),
       error = COALESCE(error, 'Marked failed by AnyaHealth orphan cleanup: stale heartbeat or never-started queued job')
   WHERE (
     (status = 'queued' AND created_at < datetime('now', '-2 hours'))
     OR (
       status = 'running'
       AND (
         (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < datetime('now', '-10 minutes'))
         OR (last_heartbeat_at IS NULL AND COALESCE(started_at, created_at) < datetime('now', '-2 hours'))
       )
     )
   )`

function ago(seconds) {
  // Build a UTC timestamp `seconds` in the past, in SQLite's DATETIME format.
  const t = Date.now() - seconds * 1000
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

function insertJob(db, fields) {
  db.prepare(
    `INSERT INTO crawler_jobs (id, type, status, created_at, started_at, last_heartbeat_at, completed_at, error)
     VALUES (@id, @type, @status, @created_at, @started_at, @last_heartbeat_at, @completed_at, @error)`,
  ).run({
    id: fields.id,
    type: fields.type ?? 'comprehensive',
    status: fields.status,
    created_at: fields.created_at,
    started_at: fields.started_at ?? null,
    last_heartbeat_at: fields.last_heartbeat_at ?? null,
    completed_at: fields.completed_at ?? null,
    error: fields.error ?? null,
  })
}

function getStatus(db, id) {
  return db.prepare('SELECT status, error FROM crawler_jobs WHERE id = ?').get(id)
}

test('healthy long-running geo crawl with recent heartbeat is NOT killed', () => {
  const db = makeDb()
  insertJob(db, {
    id: 'healthy-geo',
    status: 'running',
    created_at: ago(3 * 60 * 60), // 3h ago — well past the old 2h threshold
    started_at: ago(3 * 60 * 60),
    last_heartbeat_at: ago(30), // heartbeated 30s ago — clearly alive
  })

  db.prepare(ORPHAN_CLEANUP_SQL_SQLITE).run()

  assert.equal(getStatus(db, 'healthy-geo').status, 'running', 'healthy long-running job must survive cleanup')
})

test('stale-heartbeat running job is marked failed', () => {
  const db = makeDb()
  insertJob(db, {
    id: 'stale-running',
    status: 'running',
    created_at: ago(60 * 60),
    started_at: ago(60 * 60),
    last_heartbeat_at: ago(20 * 60), // 20 minutes since last heartbeat — worker is dead
  })

  db.prepare(ORPHAN_CLEANUP_SQL_SQLITE).run()

  const row = getStatus(db, 'stale-running')
  assert.equal(row.status, 'failed', 'stale-heartbeat job must be marked failed')
  assert.match(row.error, /AnyaHealth orphan cleanup/)
})

test('running job that never heartbeated AND is >2h old is marked failed', () => {
  const db = makeDb()
  insertJob(db, {
    id: 'never-heartbeat-old',
    status: 'running',
    created_at: ago(3 * 60 * 60),
    started_at: ago(3 * 60 * 60),
    last_heartbeat_at: null,
  })

  db.prepare(ORPHAN_CLEANUP_SQL_SQLITE).run()

  assert.equal(getStatus(db, 'never-heartbeat-old').status, 'failed')
})

test('running job that never heartbeated and is fresh (<2h) is left alone', () => {
  const db = makeDb()
  insertJob(db, {
    id: 'never-heartbeat-fresh',
    status: 'running',
    created_at: ago(30 * 60), // 30 minutes
    started_at: ago(30 * 60),
    last_heartbeat_at: null,
  })

  db.prepare(ORPHAN_CLEANUP_SQL_SQLITE).run()

  assert.equal(getStatus(db, 'never-heartbeat-fresh').status, 'running')
})

test('queued job stuck >2h is marked failed', () => {
  const db = makeDb()
  insertJob(db, {
    id: 'stuck-queued',
    status: 'queued',
    created_at: ago(3 * 60 * 60),
  })

  db.prepare(ORPHAN_CLEANUP_SQL_SQLITE).run()

  assert.equal(getStatus(db, 'stuck-queued').status, 'failed')
})

test('fresh queued job is left alone', () => {
  const db = makeDb()
  insertJob(db, {
    id: 'fresh-queued',
    status: 'queued',
    created_at: ago(30 * 60),
  })

  db.prepare(ORPHAN_CLEANUP_SQL_SQLITE).run()

  assert.equal(getStatus(db, 'fresh-queued').status, 'queued')
})

test('completed and failed jobs are never touched', () => {
  const db = makeDb()
  insertJob(db, {
    id: 'old-completed',
    status: 'completed',
    created_at: ago(10 * 60 * 60),
    completed_at: ago(8 * 60 * 60),
  })
  insertJob(db, {
    id: 'old-failed',
    status: 'failed',
    created_at: ago(10 * 60 * 60),
    completed_at: ago(8 * 60 * 60),
    error: 'something else',
  })

  db.prepare(ORPHAN_CLEANUP_SQL_SQLITE).run()

  assert.equal(getStatus(db, 'old-completed').status, 'completed')
  assert.equal(getStatus(db, 'old-failed').status, 'failed')
  assert.equal(getStatus(db, 'old-failed').error, 'something else', 'pre-existing error must not be overwritten')
})

test('end-to-end: realistic mix of jobs after a 2h13m geo crawl was running', () => {
  // Reproduces the exact scenario that broke our run:
  //   - a healthy geo crawl that's been running 2h13m with heartbeats every 60s
  //   - an old queued job that's stuck
  //   - a fresh queued job
  //   - an old failed job
  // Only the stuck queued job should change.
  const db = makeDb()
  insertJob(db, {
    id: 'live-geo-crawl',
    status: 'running',
    created_at: ago(2 * 60 * 60 + 13 * 60),
    started_at: ago(2 * 60 * 60 + 13 * 60),
    last_heartbeat_at: ago(45),
  })
  insertJob(db, {
    id: 'stuck-queued',
    status: 'queued',
    created_at: ago(4 * 60 * 60),
  })
  insertJob(db, {
    id: 'fresh-queued',
    status: 'queued',
    created_at: ago(30),
  })
  insertJob(db, {
    id: 'old-failed',
    status: 'failed',
    created_at: ago(10 * 60 * 60),
    completed_at: ago(8 * 60 * 60),
    error: 'previous failure',
  })

  db.prepare(ORPHAN_CLEANUP_SQL_SQLITE).run()

  assert.equal(getStatus(db, 'live-geo-crawl').status, 'running', 'live geo crawl must survive — this is the regression we are guarding against')
  assert.equal(getStatus(db, 'stuck-queued').status, 'failed')
  assert.equal(getStatus(db, 'fresh-queued').status, 'queued')
  assert.equal(getStatus(db, 'old-failed').status, 'failed')
})
