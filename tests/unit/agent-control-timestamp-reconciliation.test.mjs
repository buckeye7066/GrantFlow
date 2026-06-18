/**
 * Agent Control Center — "last run" timestamp reconciliation.
 *
 * The Control Center per-agent status cards (adapter.getStatus) used to read
 * each agent's own run table `started_at`, while the telemetry summary read
 * MAX(agent_activity_events.created_at). Those differ by the run's duration, so
 * the two surfaces disagreed. The fix routes BOTH through the unified
 * agent_activity_events stream (getLastRunAtFromEvents), with a fallback to the
 * run table when no unified events exist yet.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTelemetryDb, nextId, isoMinutesAgo } from './agent-telemetry-test-helpers.mjs'
import { getLastRunAtFromEvents } from '../../backend/services/agentTelemetry/agentTelemetryStore.js'
import { SamAgentAdapter } from '../../backend/services/agentControl/agentAdapters/samAgentAdapter.js'

function insertEvent(db, { agent, status = 'succeeded', createdAt }) {
  db.prepare(
    `INSERT INTO agent_activity_events (id, agent_name, event_type, status, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(nextId('evt'), agent, `agent.${agent}.main`, status, createdAt)
}

// The real sam_runs has more columns than the shared fixture; create the shape
// SamAgentAdapter.getStatus actually SELECTs so its run-table read succeeds.
function installSamRuns(db) {
  db.exec(`CREATE TABLE sam_runs (
    id TEXT PRIMARY KEY,
    started_at DATETIME,
    completed_at DATETIME,
    status TEXT,
    mode TEXT,
    health_score REAL
  )`)
}

test('getLastRunAtFromEvents returns the most recent event time for that agent only', async () => {
  const db = makeTelemetryDb()
  const recent = isoMinutesAgo(5)
  insertEvent(db, { agent: 'sam', createdAt: isoMinutesAgo(60) })
  insertEvent(db, { agent: 'sam', createdAt: recent })
  insertEvent(db, { agent: 'robert', createdAt: isoMinutesAgo(1) }) // other agent must be ignored

  assert.equal(await getLastRunAtFromEvents(db, 'sam'), recent)
  assert.equal(await getLastRunAtFromEvents(db, 'nobody'), null)
})

test('returns null when the unified events table is absent (older DBs)', async () => {
  // A bare sqlite db with no telemetry tables.
  const { default: Database } = await import('better-sqlite3')
  const raw = new Database(':memory:')
  const db = {
    dialect: 'sqlite',
    prepare: (sql) => {
      const s = raw.prepare(sql)
      return { get: (...a) => s.get(...a), all: (...a) => s.all(...a), run: (...a) => s.run(...a) }
    },
    exec: (sql) => raw.exec(sql),
  }
  assert.equal(await getLastRunAtFromEvents(db, 'sam'), null)
  raw.close()
})

test('SamAgentAdapter.getStatus reconciles last_run_at to the unified event stream', async () => {
  const db = makeTelemetryDb()
  installSamRuns(db)
  const runStarted = isoMinutesAgo(60)
  const eventAt = isoMinutesAgo(8)
  db.prepare(`INSERT INTO sam_runs (id, started_at, status) VALUES (?, ?, ?)`).run(nextId('run'), runStarted, 'completed')
  insertEvent(db, { agent: 'sam', status: 'succeeded', createdAt: eventAt })

  const status = await new SamAgentAdapter().getStatus({ db })
  // The card must match the telemetry timeline (event time), not the run start.
  assert.equal(status.last_run_at, eventAt)
  assert.notEqual(status.last_run_at, runStarted)
})

test('SamAgentAdapter.getStatus falls back to run started_at when no unified events exist', async () => {
  const db = makeTelemetryDb() // events table exists but is empty
  installSamRuns(db)
  const runStarted = isoMinutesAgo(30)
  db.prepare(`INSERT INTO sam_runs (id, started_at, status) VALUES (?, ?, ?)`).run(nextId('run'), runStarted, 'completed')

  const status = await new SamAgentAdapter().getStatus({ db })
  assert.equal(status.last_run_at, runStarted)
})
