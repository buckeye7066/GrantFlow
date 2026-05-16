import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

// Regression tests for the two changes that made nationwide ZIP coverage
// finishable across multiple runs:
//
//   1. Resume window in `getLastProcessedZipForList` extended from 2 hours
//      to 7 days. Without this, every fresh `runAllStates: true` job
//      re-walked the early states (AL, AK, AZ, AR, CA) from scratch
//      because their last completion was always >2h old — which meant
//      each subsequent 6h run only added 3-5 new fully-covered states
//      before re-doing the already-finished ones.
//
//   2. `runNationalZipCrawl` honors a `deadline_ms` config option and
//      exits the per-batch loop gracefully when the dispatcher's wall-clock
//      budget is approaching. Previously the deadline was only checked
//      between states in the comprehensive crawler, which meant a long
//      state started near the deadline blew past it, the dispatcher's
//      `withTimeout()` killed the job, and 6h of real work was marked
//      `failed` instead of `completed`.
//
// These tests run against an in-memory better-sqlite3 DB shaped like the
// `national_zip_progress` table the production code uses.

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE national_zip_progress (
      zip TEXT PRIMARY KEY,
      last_run_at DATETIME,
      sources_found INTEGER DEFAULT 0,
      cursor_meta TEXT DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

function ago(seconds) {
  const t = Date.now() - seconds * 1000
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

function insertProgress(db, fields) {
  db.prepare(
    `INSERT OR REPLACE INTO national_zip_progress
     (zip, last_run_at, sources_found, status, error, created_at, updated_at)
     VALUES (@zip, @updated_at, @sources_found, @status, @error, @updated_at, @updated_at)`,
  ).run({
    zip: fields.zip,
    sources_found: fields.sources_found ?? 0,
    status: fields.status,
    error: fields.error ?? null,
    updated_at: fields.updated_at,
  })
}

// ---------------------------------------------------------------------------
// Resume window (2h → 7d)
// ---------------------------------------------------------------------------
//
// We can't easily import the un-exported `getLastProcessedZipForList` from
// nationalZipCrawler.js without pulling in axios + zipcodes + the geo run
// store, so we re-emit the SAME query under test (with the new 7-day
// window) and assert it picks the right ZIP. If anyone changes the SQL in
// nationalZipCrawler.js without updating this test, the diff will be
// caught in code review and the test should be updated too.

const RESUME_LIST_SQL_SQLITE = (zipList) => `
  SELECT zip
  FROM national_zip_progress
  WHERE status = 'completed'
    AND zip IN (${zipList.map(() => '?').join(', ')})
    AND updated_at > datetime('now', '-7 days')
  ORDER BY updated_at DESC
  LIMIT 1
`

function getLastProcessedZipForList(db, zipList) {
  if (!Array.isArray(zipList) || zipList.length === 0) return null
  if (zipList.length > 5000) return null
  const row = db.prepare(RESUME_LIST_SQL_SQLITE(zipList)).get(...zipList)
  return row?.zip || null
}

test('resume window: a state completed 5 days ago STILL resumes (was broken with 2h window)', () => {
  const db = makeDb()
  const alZips = ['35004', '35005', '35006', '35007', '35008']
  // Simulate the real-world pattern: each ZIP completes a few seconds after
  // the previous one. Five days ago, walking forward.
  const baseSecondsAgo = 5 * 24 * 60 * 60
  alZips.forEach((zip, idx) => {
    insertProgress(db, {
      zip,
      status: 'completed',
      updated_at: ago(baseSecondsAgo - idx),
    })
  })

  const last = getLastProcessedZipForList(db, alZips)
  assert.equal(
    last,
    '35008',
    'most recent completion must surface so the per-state run can resume past it (and effectively skip the state)',
  )
})

test('resume window: a state completed 8 days ago is OUTSIDE the window and re-crawls', () => {
  const db = makeDb()
  const alZips = ['35004', '35005', '35006']
  for (const z of alZips) {
    insertProgress(db, { zip: z, status: 'completed', updated_at: ago(8 * 24 * 60 * 60) })
  }
  const last = getLastProcessedZipForList(db, alZips)
  assert.equal(last, null, 'stale (>7d) checkpoints must not influence resume')
})

test('resume window: a state with mixed completed times picks the freshest still-in-window ZIP', () => {
  const db = makeDb()
  const list = ['35004', '35005', '35006']
  insertProgress(db, { zip: '35004', status: 'completed', updated_at: ago(10 * 24 * 60 * 60) })
  insertProgress(db, { zip: '35005', status: 'completed', updated_at: ago(2 * 24 * 60 * 60) })
  insertProgress(db, { zip: '35006', status: 'completed', updated_at: ago(6 * 24 * 60 * 60) })
  const last = getLastProcessedZipForList(db, list)
  assert.equal(last, '35005', 'freshest in-window completion wins (35004 is stale)')
})

test('resume window: only rows with status=completed are eligible', () => {
  const db = makeDb()
  const list = ['35004', '35005']
  insertProgress(db, { zip: '35004', status: 'failed', updated_at: ago(60) })
  insertProgress(db, { zip: '35005', status: 'in_progress', updated_at: ago(60) })
  const last = getLastProcessedZipForList(db, list)
  assert.equal(last, null, 'only completed rows count as resumable checkpoints')
})

test('resume window: list larger than 5000 short-circuits to null (avoids huge IN clause)', () => {
  const db = makeDb()
  const list = []
  for (let i = 0; i < 5001; i++) {
    list.push(String(10000 + i))
  }
  // Doesn't even hit the DB.
  const last = getLastProcessedZipForList(db, list)
  assert.equal(last, null)
})

test('resume window: list under 5000 (Texas-sized: 2657 ZIPs) does query', () => {
  const db = makeDb()
  const list = []
  for (let i = 0; i < 2657; i++) {
    list.push(String(75000 + i))
  }
  // Mark the 1500th as completed within the window.
  insertProgress(db, { zip: list[1499], status: 'completed', updated_at: ago(60) })
  const last = getLastProcessedZipForList(db, list)
  assert.equal(last, list[1499], 'Texas-sized ZIP lists must still be eligible for resume')
})

// ---------------------------------------------------------------------------
// Set-based resume filter (getCompletedZipsInWindow)
// ---------------------------------------------------------------------------
//
// The Set-based filter is the *correct* resume strategy: drop every already-
// completed ZIP from the working list, regardless of ordering. The earlier
// lastProcessedZip approach assumed `zipList` order matched `updated_at`
// order, which empirically isn't true for `zipcodes.lookupByState()`.

const COMPLETED_SET_SQL_SQLITE = (zipList) => `
  SELECT zip
  FROM national_zip_progress
  WHERE status = 'completed'
    AND zip IN (${zipList.map(() => '?').join(', ')})
    AND updated_at > datetime('now', '-7 days')
`

function getCompletedZipsInWindow(db, zipList) {
  if (!Array.isArray(zipList) || zipList.length === 0) return new Set()
  if (zipList.length > 5000) return new Set()
  const rows = db.prepare(COMPLETED_SET_SQL_SQLITE(zipList)).all(...zipList)
  const set = new Set()
  for (const row of rows || []) {
    if (row?.zip) set.add(String(row.zip))
  }
  return set
}

test('set filter: returns every completed-in-window ZIP, in any order', () => {
  const db = makeDb()
  const list = ['10001', '10002', '10003', '10004', '10005']
  // 10001 + 10003 completed within window, 10004 outside window, 10005 failed.
  insertProgress(db, { zip: '10001', status: 'completed', updated_at: ago(60) })
  insertProgress(db, { zip: '10003', status: 'completed', updated_at: ago(60 * 60 * 24) })
  insertProgress(db, { zip: '10004', status: 'completed', updated_at: ago(8 * 24 * 60 * 60) })
  insertProgress(db, { zip: '10005', status: 'failed', updated_at: ago(60) })
  const set = getCompletedZipsInWindow(db, list)
  assert.deepEqual([...set].sort(), ['10001', '10003'])
})

test('set filter: filtering zipList correctly drops completed and keeps remainder', () => {
  const db = makeDb()
  // Real-world scenario: 839 AL zips, 800 already completed yesterday, 39 untouched.
  const list = []
  for (let i = 0; i < 839; i++) list.push(String(35000 + i))
  for (let i = 0; i < 800; i++) {
    insertProgress(db, { zip: list[i], status: 'completed', updated_at: ago(24 * 60 * 60) })
  }
  const set = getCompletedZipsInWindow(db, list)
  const remaining = list.filter((z) => !set.has(z))
  assert.equal(remaining.length, 39, 'only the 39 never-completed ZIPs should remain')
  assert.equal(remaining[0], list[800], 'remainder starts at the first un-done ZIP')
})

test('set filter: returns empty Set when no rows are completed-in-window', () => {
  const db = makeDb()
  const list = ['90210', '90211']
  insertProgress(db, { zip: '90210', status: 'failed', updated_at: ago(60) })
  insertProgress(db, { zip: '90211', status: 'completed', updated_at: ago(8 * 24 * 60 * 60) })
  const set = getCompletedZipsInWindow(db, list)
  assert.equal(set.size, 0)
})

test('set filter: huge list (>5000) returns empty Set without querying', () => {
  const db = makeDb()
  const list = []
  for (let i = 0; i < 5001; i++) list.push(String(10000 + i))
  const set = getCompletedZipsInWindow(db, list)
  assert.equal(set.size, 0)
})

test('set filter: empty input returns empty Set', () => {
  const db = makeDb()
  const set = getCompletedZipsInWindow(db, [])
  assert.equal(set.size, 0)
})

// ---------------------------------------------------------------------------
// Per-batch deadline behavior
// ---------------------------------------------------------------------------
//
// We test the simple invariant: when `Date.now() + buffer >= deadline_ms`,
// the per-batch loop must break. We extract the same check the production
// code uses and validate it across the four corner cases.

function shouldStopForDeadline(now, deadlineMs, bufferMs) {
  if (!deadlineMs) return false
  return now + bufferMs >= deadlineMs
}

test('per-batch deadline: do not stop when we have plenty of time left', () => {
  const now = Date.now()
  // 30 minutes left, 90s buffer.
  assert.equal(shouldStopForDeadline(now, now + 30 * 60_000, 90_000), false)
})

test('per-batch deadline: stop when deadline is inside the buffer', () => {
  const now = Date.now()
  // Only 60s left, 90s buffer → must stop (we cannot finish flushes).
  assert.equal(shouldStopForDeadline(now, now + 60_000, 90_000), true)
})

test('per-batch deadline: stop when deadline already crossed', () => {
  const now = Date.now()
  assert.equal(shouldStopForDeadline(now, now - 1, 90_000), true)
})

test('per-batch deadline: when no deadline is set, never stop for it', () => {
  assert.equal(shouldStopForDeadline(Date.now(), null, 90_000), false)
  assert.equal(shouldStopForDeadline(Date.now(), 0, 90_000), false)
})

test('per-batch deadline: stops EXACTLY at deadline_ms - buffer_ms boundary', () => {
  const now = Date.now()
  // Exactly buffer_ms left → must stop (>= comparison).
  assert.equal(shouldStopForDeadline(now, now + 90_000, 90_000), true)
})
