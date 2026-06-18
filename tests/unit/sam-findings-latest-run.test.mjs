/**
 * Sam findings must reflect the LATEST run, not accumulate across every run in
 * the time window. Sam re-audits from scratch each cycle, so counting all
 * findings in the window made the dashboard totals grow run-over-run (the
 * "16 -> 32 Tool invocation failed" creep the re-audit reported).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateSam } from '../../backend/services/agentTelemetry/agentTelemetryAggregator.js'
import { resolveRange } from '../../backend/services/agentTelemetry/agentTelemetryTypes.js'
import { makeTelemetryDb, isoMinutesAgo } from './agent-telemetry-test-helpers.mjs'

const range24h = () => resolveRange({ range: '24h' })

function makeDb() {
  const db = makeTelemetryDb({ installAgents: ['sam_runs'] })
  // Realistic sam_findings shape (the shared fixture omits sam_run_id).
  db._raw.exec(`
    CREATE TABLE sam_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sam_run_id TEXT,
      severity TEXT,
      status TEXT,
      event_type TEXT,
      title TEXT,
      description TEXT,
      file_path TEXT,
      details_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

const insertRun = (db, id, minutesAgo) =>
  db._raw.prepare('INSERT INTO sam_runs (id, started_at, status) VALUES (?, ?, ?)')
    .run(id, isoMinutesAgo(minutesAgo), 'completed')

const insertFinding = (db, runId, severity, minutesAgo) =>
  db._raw.prepare('INSERT INTO sam_findings (sam_run_id, severity, status, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, severity, 'open', isoMinutesAgo(minutesAgo))

test('sam errors_found reflects only the latest run (no run-over-run accumulation)', async () => {
  const db = makeDb()
  insertRun(db, 'run-old', 120)
  insertRun(db, 'run-new', 5)
  // Both runs are inside the 24h window: window-wide counting would total 7.
  for (let i = 0; i < 5; i += 1) insertFinding(db, 'run-old', 'high', 119)
  for (let i = 0; i < 2; i += 1) insertFinding(db, 'run-new', 'high', 4)

  const sam = await aggregateSam(db, range24h())

  assert.equal(sam.primary_metrics.errors_found, 2, 'latest run only — not the cumulative 7')
  assert.equal(sam.primary_metrics.severity_breakdown.high, 2)
})

test('falls back to the window when findings have no sam_run_id (older shape)', async () => {
  const db = makeTelemetryDb({ installAgents: ['sam_runs', 'sam_findings'] }) // fixture: no sam_run_id column
  db._raw.prepare('INSERT INTO sam_findings (id, severity, status) VALUES (?, ?, ?)').run('f1', 'high', 'open')
  db._raw.prepare('INSERT INTO sam_findings (id, severity, status) VALUES (?, ?, ?)').run('f2', 'medium', 'open')

  const sam = await aggregateSam(db, range24h())
  assert.equal(sam.primary_metrics.errors_found, 2, 'window fallback still counts findings')
})
