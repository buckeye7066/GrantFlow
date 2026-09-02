/**
 * Agent Control Center — real telemetry, honest completion, and the two
 * previously-broken metrics queries.
 *
 * Covers root causes #1 (hollow "completed" / synthetic telemetry) and #3
 * (Yana integer=boolean, John missing alias_status) from the agent-system fix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { normalizeSqliteArgs } from '../../backend/db/index.js'
import {
  ensureSchema,
  createRun,
  createSteps,
  getRun,
  getRunHighlights,
  setRunStatus,
} from '../../backend/services/agentControl/agentControlStore.js'
import { executeRun } from '../../backend/services/agentControl/agentControlOrchestrator.js'
import { setAdapter, resetRegistry } from '../../backend/services/agentControl/agentAdapters/agentAdapterRegistry.js'
import { readActivityEvents } from '../../backend/services/agentTelemetry/agentTelemetryStore.js'
import { aggregateYana, aggregateJohn } from '../../backend/services/agentTelemetry/agentTelemetryAggregator.js'
import { resolveRange } from '../../backend/services/agentTelemetry/agentTelemetryTypes.js'

const ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS agent_activity_events (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    agent_name TEXT NOT NULL, event_type TEXT NOT NULL, status TEXT, severity TEXT,
    title TEXT, description TEXT, metric_key TEXT, metric_value REAL,
    entity_type TEXT, entity_id TEXT, user_id TEXT, profile_id TEXT, organization_id TEXT,
    state TEXT, county TEXT, city TEXT, latitude REAL, longitude REAL,
    details_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`

const FULL_RANGE = { startIso: '1970-01-01T00:00:00.000Z', endIso: '2999-01-01T00:00:00.000Z' }

// Production-faithful SQLite db: better-sqlite3 get/all/run are SYNCHRONOUS in
// the real adapter (backend/db/index.js SqliteDb), and the telemetry store's
// SQLite paths rely on that (they don't await). normalizeSqliteArgs matches the
// production coercion (booleans -> 1/0, etc.).
function createSqliteTestDb(schema = null) {
  const sqlite = new Database(':memory:')
  if (schema) sqlite.exec(schema)
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: (...p) => stmt.get(...normalizeSqliteArgs(p)),
        all: (...p) => stmt.all(...normalizeSqliteArgs(p)),
        run: (...p) => {
          const r = stmt.run(...normalizeSqliteArgs(p))
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
        },
      }
    },
    exec(sql) { sqlite.exec(sql) },
  }
}

function stubAdapter(summary) {
  return { start: async () => ({ ok: true, status: 'completed', summary }) }
}

async function runOneStep(db, agent, summary) {
  await ensureSchema(db)
  setAdapter(agent, stubAdapter(summary))
  try {
    const runId = await createRun(db, {
      runType: `${agent}_only`,
      requestedAgents: [agent],
      options: {},
      status: 'queued',
      adminEmail: 'owner@example.invalid',
      startedByEmail: 'owner@example.invalid',
    })
    await createSteps(db, runId, [{ agentName: agent, stepName: `${agent}_main`, stepOrder: 0, status: 'queued', progress: { stage: 'main' } }])
    await executeRun({ db, runId })
    return await getRun(db, runId)
  } finally {
    resetRegistry()
  }
}

test('a step that persists work → run completed + a real succeeded telemetry event', async () => {
  const db = createSqliteTestDb(ACTIVITY_DDL)
  const run = await runOneStep(db, 'sam', { agent: 'sam', sam_run_id: 'r1', findings_total: 2 })
  assert.equal(run.status, 'completed')
  const events = await readActivityEvents(db, { ...FULL_RANGE, limit: 50 })
  const samEvents = events.filter((e) => e.agent_name === 'sam')
  assert.ok(samEvents.length >= 1, 'expected a unified agent_activity_events row for sam')
  assert.ok(samEvents.some((e) => e.status === 'succeeded'), 'expected a succeeded telemetry event')
})

test('a step that does no real work → run completed_noop + a noop telemetry event (honest)', async () => {
  const db = createSqliteTestDb(ACTIVITY_DDL)
  const run = await runOneStep(db, 'john', { agent: 'john', drafts_created: 0, drafts_blocked: 0 })
  assert.equal(run.status, 'completed_noop', 'a run with zero persisted work must NOT report completed')
  assert.ok(run.completed_at, 'completed_noop must carry a terminal completion timestamp')
  const events = await readActivityEvents(db, { ...FULL_RANGE, limit: 50 })
  const johnEvents = events.filter((e) => e.agent_name === 'john')
  assert.ok(johnEvents.some((e) => e.status === 'noop'), 'expected an honest noop telemetry event')
})

test('aggregateYana does not throw on integer pushed_to_john (#3: integer = boolean)', async () => {
  const db = createSqliteTestDb(`
    CREATE TABLE yana_lead_candidates (
      id TEXT, qualification_status TEXT, pushed_to_john INTEGER DEFAULT 0,
      lead_score REAL, urgency_score REAL, created_at TEXT
    );`)
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO yana_lead_candidates (id, qualification_status, pushed_to_john, created_at) VALUES ('a','qualified',1,?)`).run(now)
  await db.prepare(`INSERT INTO yana_lead_candidates (id, qualification_status, pushed_to_john, created_at) VALUES ('b','qualified',0,?)`).run(now)
  const out = await aggregateYana(db, resolveRange({ range: '24h' }))
  assert.ok(!(out.notes || []).some((n) => /unavailable/i.test(n)), `no metrics error expected, got: ${JSON.stringify(out.notes)}`)
  assert.equal(out.primary_metrics.leads_sent_to_john, 1)
})

test('aggregateJohn does not throw when john_alias_checks lacks alias_status (#3)', async () => {
  const db = createSqliteTestDb(`
    CREATE TABLE john_email_drafts (id TEXT, draft_status TEXT, created_at TEXT);
    CREATE TABLE john_alias_checks (id TEXT, alias_verified INTEGER, alias_send_supported INTEGER, checked_at TEXT);`)
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO john_alias_checks (id, alias_verified, alias_send_supported, checked_at) VALUES ('a',1,1,?)`).run(now)
  const out = await aggregateJohn(db, resolveRange({ range: '24h' }))
  assert.ok(!(out.notes || []).some((n) => /unavailable|does not exist/i.test(n)), `no metrics error expected, got: ${JSON.stringify(out.notes)}`)
  assert.equal(out.primary_metrics.alias_status, 'verified')
})


test('scheduled clean cycles appear in full-cycle and success highlights', async () => {
  const db = createSqliteTestDb()
  await ensureSchema(db)
  const runId = await createRun(db, {
    runType: 'scheduled_cycle',
    requestedAgents: ['sam', 'robert', 'yana', 'john', 'hamilton'],
    options: { scheduled: true },
    status: 'queued',
    adminEmail: 'owner@example.invalid',
    startedByEmail: 'owner@example.invalid',
  })
  await setRunStatus(db, runId, 'completed_noop')
  const highlights = await getRunHighlights(db)
  assert.equal(highlights.last_full_cycle?.id, runId)
  assert.equal(highlights.last_success?.id, runId)
  assert.ok(highlights.last_success?.completed_at)
})
