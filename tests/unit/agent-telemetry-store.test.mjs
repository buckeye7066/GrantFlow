import test from 'node:test'
import assert from 'node:assert/strict'

import {
  tableExists,
  tablesExist,
  insertActivityEvent,
  readActivityEvents,
  countEventsByAgent,
  incrementDailyRollup,
  columnsFor,
} from '../../backend/services/agentTelemetry/agentTelemetryStore.js'
import { makeTelemetryDb, nextId, isoMinutesAgo } from './agent-telemetry-test-helpers.mjs'

test('tableExists returns true for unified tables and false for missing ones', async () => {
  const db = makeTelemetryDb()
  assert.equal(await tableExists(db, 'agent_activity_events'), true)
  assert.equal(await tableExists(db, 'agent_daily_rollups'), true)
  assert.equal(await tableExists(db, 'no_such_table'), false)
})

test('tableExists rejects malformed identifiers without throwing', async () => {
  const db = makeTelemetryDb()
  assert.equal(await tableExists(db, 'drop table; --'), false)
  assert.equal(await tableExists(db, ''), false)
  assert.equal(await tableExists(db, 12345), false)
})

test('tablesExist returns map of names to booleans', async () => {
  const db = makeTelemetryDb({ installAgents: ['john_email_drafts'] })
  const map = await tablesExist(db, ['agent_activity_events', 'john_email_drafts', 'missing_table'])
  assert.equal(map.agent_activity_events, true)
  assert.equal(map.john_email_drafts, true)
  assert.equal(map.missing_table, false)
})

test('insertActivityEvent ignores invalid agent names', async () => {
  const db = makeTelemetryDb()
  const id = await insertActivityEvent(db, { agent_name: 'evil_agent', event_type: 'x' })
  assert.equal(id, null)
})

test('insertActivityEvent + readActivityEvents round-trip with details_json', async () => {
  const db = makeTelemetryDb()
  await insertActivityEvent(db, {
    agent_name: 'yana',
    event_type: 'lead_qualified',
    status: 'succeeded',
    severity: 'info',
    title: 'Qualified Foo Foundation',
    details_json: { score: 0.84 },
    state: 'OH',
  })
  const events = await readActivityEvents(db, { agent: 'yana' })
  assert.equal(events.length, 1)
  assert.equal(events[0].agent_name, 'yana')
  assert.deepEqual(events[0].details_json, { score: 0.84 })
  assert.equal(events[0].state, 'OH')
})

test('readActivityEvents filters by status and time range', async () => {
  const db = makeTelemetryDb()
  // far in the past
  db._raw.prepare(
    `INSERT INTO agent_activity_events (id, agent_name, event_type, status, created_at)
       VALUES (?, ?, 'old_event', 'succeeded', ?)`,
  ).run(nextId(), 'sam', isoMinutesAgo(60 * 24 * 10))
  // recent
  await insertActivityEvent(db, { agent_name: 'sam', event_type: 'recent_event', status: 'failed' })
  const recent = await readActivityEvents(db, { startIso: isoMinutesAgo(60), agent: 'sam' })
  assert.equal(recent.length, 1)
  assert.equal(recent[0].event_type, 'recent_event')

  const onlyFailed = await readActivityEvents(db, { status: 'failed' })
  assert.equal(onlyFailed.length, 1)
  assert.equal(onlyFailed[0].status, 'failed')
})

test('countEventsByAgent groups by agent and counts statuses', async () => {
  const db = makeTelemetryDb()
  for (const s of ['succeeded', 'succeeded', 'failed']) {
    await insertActivityEvent(db, { agent_name: 'john', event_type: 'agent_run', status: s })
  }
  await insertActivityEvent(db, { agent_name: 'yana', event_type: 'agent_run', status: 'succeeded' })

  const rows = await countEventsByAgent(db, {})
  const john = rows.find((r) => r.agent_name === 'john')
  assert.ok(john, 'john row present')
  assert.equal(Number(john.total), 3)
  assert.equal(Number(john.succeeded), 2)
  assert.equal(Number(john.failed), 1)
})

test('incrementDailyRollup upserts and accumulates', async () => {
  const db = makeTelemetryDb()
  await incrementDailyRollup(db, { agent_name: 'yana', metric_key: 'leads_qualified', metric_value: 5 })
  await incrementDailyRollup(db, { agent_name: 'yana', metric_key: 'leads_qualified', metric_value: 7 })
  const row = db._raw
    .prepare(`SELECT metric_value FROM agent_daily_rollups WHERE agent_name='yana' AND metric_key='leads_qualified'`)
    .get()
  assert.equal(row.metric_value, 12)
})

test('columnsFor returns column names for installed table and [] for missing', async () => {
  const db = makeTelemetryDb({ installAgents: ['robert_opportunity_candidates'] })
  const cols = await columnsFor(db, 'robert_opportunity_candidates')
  assert.ok(cols.includes('city'), 'city present')
  assert.ok(cols.includes('state'), 'state present')

  const empty = await columnsFor(db, 'no_such_table')
  assert.deepEqual(empty, [])
})

test('store no-ops gracefully when unified tables are missing', async () => {
  const db = makeTelemetryDb()
  // simulate a deployment where the unified table was never created
  db._raw.exec('DROP TABLE agent_activity_events')
  const id = await insertActivityEvent(db, { agent_name: 'sam', event_type: 'x' })
  assert.equal(id, null)
  const events = await readActivityEvents(db, {})
  assert.deepEqual(events, [])
})
