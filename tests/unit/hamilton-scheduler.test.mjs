/**
 * Hamilton scheduler — re-pick of deferred waiting_for_window tasks.
 *
 * The orchestrator defers out-of-window autonomous portal runs to
 * status='waiting_for_window' with next_retry_at = next window start. The
 * HamiltonAgentAdapter re-picks those due tasks; this scheduler is the timer
 * that drives the adapter. These tests prove:
 *
 *   1. The env gates (HAMILTON_RUN_ON_SCHEDULE + HAMILTON_ENABLE_BROWSER_AUTOMATION)
 *      are AND-ed and OFF by default — the scheduler never silently arms.
 *   2. Interval/batch resolution clamps to safe bounds.
 *   3. A tick actually SELECTs a DUE waiting_for_window task (and ignores a
 *      not-yet-due one), proving the re-pick query reaches the deferred task.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  startHamiltonScheduler,
  stopHamiltonScheduler,
  __testing__,
} from '../../backend/services/hamilton/hamiltonScheduler.js'

const { tick, shouldRunOnSchedule, resolveIntervalMs, resolveBatchSize, _resetState } = __testing__

function makeDb() {
  return wrapSqlite(new Database(':memory:'))
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides)
  const saved = {}
  for (const k of keys) saved[k] = process.env[k]
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k]
    else process.env[k] = overrides[k]
  }
  try {
    return fn()
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test('gate is OFF by default (neither env set)', () => {
  withEnv(
    { HAMILTON_RUN_ON_SCHEDULE: undefined, HAMILTON_ENABLE_BROWSER_AUTOMATION: undefined },
    () => {
      assert.equal(shouldRunOnSchedule(), false)
    },
  )
})

test('gate requires BOTH HAMILTON_RUN_ON_SCHEDULE and browser automation', () => {
  withEnv(
    { HAMILTON_RUN_ON_SCHEDULE: 'true', HAMILTON_ENABLE_BROWSER_AUTOMATION: 'false' },
    () => assert.equal(shouldRunOnSchedule(), false),
  )
  withEnv(
    { HAMILTON_RUN_ON_SCHEDULE: 'false', HAMILTON_ENABLE_BROWSER_AUTOMATION: 'true' },
    () => assert.equal(shouldRunOnSchedule(), false),
  )
  withEnv(
    { HAMILTON_RUN_ON_SCHEDULE: 'true', HAMILTON_ENABLE_BROWSER_AUTOMATION: 'true' },
    () => assert.equal(shouldRunOnSchedule(), true),
  )
})

test('startHamiltonScheduler refuses to arm when disabled', () => {
  const r = withEnv(
    { HAMILTON_RUN_ON_SCHEDULE: undefined, HAMILTON_ENABLE_BROWSER_AUTOMATION: undefined },
    () => startHamiltonScheduler({ db: makeDb() }),
  )
  assert.equal(r.started, false)
  stopHamiltonScheduler()
})

test('startHamiltonScheduler arms when both gates are on, then stops cleanly', () => {
  const r = withEnv(
    { HAMILTON_RUN_ON_SCHEDULE: 'true', HAMILTON_ENABLE_BROWSER_AUTOMATION: 'true' },
    () => startHamiltonScheduler({ db: makeDb(), logger: { info() {}, warn() {} } }),
  )
  assert.equal(r.started, true)
  assert.ok(r.intervalMs >= 60_000)
  const stop = stopHamiltonScheduler()
  assert.equal(stop.stopped, true)
})

test('resolveIntervalMs defaults to 5min and floors at 60s', () => {
  withEnv({ HAMILTON_SCHEDULE_INTERVAL_MS: undefined }, () => assert.equal(resolveIntervalMs(), 5 * 60 * 1000))
  withEnv({ HAMILTON_SCHEDULE_INTERVAL_MS: '1000' }, () => assert.equal(resolveIntervalMs(), 60 * 1000))
  withEnv({ HAMILTON_SCHEDULE_INTERVAL_MS: '900000' }, () => assert.equal(resolveIntervalMs(), 900000))
  withEnv({ HAMILTON_SCHEDULE_INTERVAL_MS: 'garbage' }, () => assert.equal(resolveIntervalMs(), 5 * 60 * 1000))
})

test('resolveBatchSize defaults to 5 and clamps to 1..25', () => {
  withEnv({ HAMILTON_SCHEDULE_BATCH_SIZE: undefined }, () => assert.equal(resolveBatchSize(), 5))
  withEnv({ HAMILTON_SCHEDULE_BATCH_SIZE: '0' }, () => assert.equal(resolveBatchSize(), 5))
  withEnv({ HAMILTON_SCHEDULE_BATCH_SIZE: '100' }, () => assert.equal(resolveBatchSize(), 25))
  withEnv({ HAMILTON_SCHEDULE_BATCH_SIZE: '3' }, () => assert.equal(resolveBatchSize(), 3))
})

test('tick skips when the gate is off', async () => {
  _resetState()
  const result = await withEnv(
    { HAMILTON_RUN_ON_SCHEDULE: undefined, HAMILTON_ENABLE_BROWSER_AUTOMATION: undefined },
    () => tick({ db: makeDb(), logger: { info() {}, warn() {} } }),
  )
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'disabled')
})

test('tick re-picks a DUE waiting_for_window task and skips a not-yet-due one', async () => {
  _resetState()
  const db = makeDb()
  // Minimal application_tasks schema covering the columns the adapter SELECTs.
  db.exec(`
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      opportunity_id TEXT,
      grant_id TEXT,
      automation_type TEXT,
      status TEXT,
      current_pipeline_stage TEXT,
      selected_from_stage TEXT,
      next_retry_at TEXT,
      updated_at TEXT
    );
  `)
  const past = new Date(Date.now() - 60_000).toISOString()
  const future = new Date(Date.now() + 60 * 60_000).toISOString()
  // DUE: window opened a minute ago → must be re-picked.
  db.prepare(
    `INSERT INTO application_tasks (id, profile_id, opportunity_id, status, next_retry_at, updated_at)
     VALUES ('due', 'p1', 'opp1', 'waiting_for_window', ?, ?)`,
  ).run(past, past)
  // NOT due: window opens in an hour → must be ignored this tick.
  db.prepare(
    `INSERT INTO application_tasks (id, profile_id, opportunity_id, status, next_retry_at, updated_at)
     VALUES ('later', 'p1', 'opp2', 'waiting_for_window', ?, ?)`,
  ).run(future, future)

  // Run a real tick. The adapter dynamically imports automateSingleSource and
  // will attempt the picked task; on this bare DB the orchestrator call fails
  // and is caught per-task, but `attempted` still reflects exactly which rows
  // the re-pick SELECT matched. That count is the load-bearing assertion: the
  // DUE waiting_for_window task is picked and the not-yet-due one is excluded.
  const result = await withEnv(
    { HAMILTON_RUN_ON_SCHEDULE: 'true', HAMILTON_ENABLE_BROWSER_AUTOMATION: 'true' },
    () => tick({ db, logger: { info() {}, warn() {} } }),
  )

  assert.equal(result.skipped, undefined)
  assert.equal(result.ran, true)
  const summary = result.result?.summary || {}
  assert.equal(
    summary.attempted,
    1,
    'exactly the one DUE waiting_for_window task should be re-picked (the not-yet-due one is excluded)',
  )
})
