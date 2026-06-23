/**
 * Agent Control Center — adapter registry + contract.
 *
 * Lightweight tests that don't drive the orchestrator end-to-end, just
 * verify each adapter implements the BaseAgentAdapter surface and
 * responds without crashing on a bare in-memory DB. We don't run Sam /
 * Robert / John / Hamilton's real entry points here — those have their
 * own dedicated test suites — we only check the adapter glue.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import { BaseAgentAdapter, makeSignal } from '../../backend/services/agentControl/agentAdapters/baseAgentAdapter.js'
import { getAdapter, listAdapters, setAdapter, resetRegistry } from '../../backend/services/agentControl/agentAdapters/agentAdapterRegistry.js'
import { ALL_AGENTS, STATUS_AGENTS, FULL_CYCLE_ORDER, RUN_TYPES, resolveAgentsForRun, agentLockName, FULL_CYCLE_LOCK } from '../../backend/services/agentControl/agentControlTypes.js'

function makeDb() {
  const sqlite = new Database(':memory:')
  return wrapSqlite(sqlite)
}

test('agentControlTypes: ALL_AGENTS lists exactly sam/robert/yana/john/hamilton', () => {
  assert.deepEqual([...ALL_AGENTS].sort(), ['hamilton', 'john', 'robert', 'sam', 'yana'])
})

test('agentControlTypes: full cycle order has Sam first, Hamilton last', () => {
  assert.deepEqual([...FULL_CYCLE_ORDER], ['sam', 'robert', 'yana', 'john', 'hamilton'])
})

test('agentControlTypes: RUN_TYPES contains every documented run type', () => {
  for (const t of ['full_cycle', 'selected_agents', 'sam_only', 'robert_only', 'yana_only', 'john_only', 'hamilton_only', 'scheduled_cycle']) {
    assert.ok(RUN_TYPES.includes(t), `RUN_TYPES missing ${t}`)
  }
})

test('agentControlTypes: resolveAgentsForRun returns the right set per type', () => {
  assert.deepEqual(resolveAgentsForRun('full_cycle', []), ['sam', 'robert', 'yana', 'john', 'hamilton'])
  assert.deepEqual(resolveAgentsForRun('sam_only', []), ['sam'])
  assert.deepEqual(resolveAgentsForRun('hamilton_only', []), ['hamilton'])
  assert.deepEqual(resolveAgentsForRun('selected_agents', ['hamilton', 'sam']), ['sam', 'hamilton'])
  assert.deepEqual(resolveAgentsForRun('selected_agents', ['unknown', 'yana']), ['yana'])
  assert.deepEqual(resolveAgentsForRun('selected_agents', []), [])
})

test('agentControlTypes: lock names are stable + per-agent', () => {
  assert.equal(FULL_CYCLE_LOCK, 'agent_control:full_cycle')
  assert.equal(agentLockName('Sam'), 'agent_control:agent:sam')
  assert.equal(agentLockName('hamilton'), 'agent_control:agent:hamilton')
})

test('registry returns one adapter per status agent (canonical + status-only anya)', () => {
  resetRegistry()
  const all = listAdapters()
  // The registry serves every STATUS_AGENT: the 5 canonical full-cycle
  // agents PLUS anya (status-only / interactive, observed but never driven
  // by the automated cycle — see agentControlTypes.STATUS_AGENTS).
  assert.deepEqual(Object.keys(all).sort(), [...STATUS_AGENTS].sort())
  for (const name of STATUS_AGENTS) {
    assert.ok(getAdapter(name), `adapter missing for ${name}`)
    assert.equal(getAdapter(name).name, name)
  }
  // Every canonical agent is still present (start/stop gate on ALL_AGENTS).
  for (const name of ALL_AGENTS) {
    assert.ok(getAdapter(name), `canonical adapter missing for ${name}`)
  }
})

test('registry setAdapter swaps + resetRegistry restores defaults', () => {
  resetRegistry()
  const original = getAdapter('sam')
  class FakeSam extends BaseAgentAdapter { constructor() { super({ name: 'sam' }) } async start() { return { ok: true, status: 'completed', summary: { fake: true } } } }
  setAdapter('sam', new FakeSam())
  const replaced = getAdapter('sam')
  assert.notEqual(replaced.constructor.name, original.constructor.name)
  resetRegistry()
  const restored = getAdapter('sam')
  assert.equal(restored.constructor.name, original.constructor.name)
})

test('every adapter implements getStatus / start / pause / stop / resume / health', async () => {
  resetRegistry()
  const db = makeDb()
  for (const name of ALL_AGENTS) {
    const adapter = getAdapter(name)
    const status = await adapter.getStatus({ db })
    assert.equal(status.agent_name, name)
    assert.equal(typeof status.health, 'string')

    const pause = await adapter.pause({ db, controlRunId: 'r1' })
    assert.equal(pause.ok, true)

    const resume = await adapter.resume({ db, controlRunId: 'r1' })
    assert.equal(resume.ok, true)

    const stop = await adapter.stop({ db, controlRunId: 'r1' })
    assert.equal(stop.ok, true)

    const health = await adapter.health({ db })
    assert.equal(health.agent_name, name)
  }
})

test('makeSignal exposes shouldStop / shouldPause / heartbeat / recordEvent / runId', async () => {
  let stopFlag = false
  let pauseFlag = false
  const heartbeats = []
  const events = []
  const signal = makeSignal({
    runId: 'r1',
    stepId: 's1',
    agentName: 'sam',
    shouldStop: () => stopFlag,
    shouldPause: () => pauseFlag,
    heartbeat: async (p) => heartbeats.push(p),
    recordEvent: async (e) => events.push(e),
  })
  assert.equal(signal.shouldStop(), false)
  assert.equal(signal.shouldPause(), false)
  await signal.heartbeat({ progress: 1 })
  await signal.recordEvent({ eventType: 'test' })
  stopFlag = true
  pauseFlag = true
  assert.equal(signal.shouldStop(), true)
  assert.equal(signal.shouldPause(), true)
  assert.equal(heartbeats.length, 1)
  assert.equal(events.length, 1)
  assert.equal(signal.runId, 'r1')
  assert.equal(signal.agentName, 'sam')
})

test('Sam adapter health reads sam_runs when present and tolerates absence', async () => {
  resetRegistry()
  const db = makeDb()
  const adapter = getAdapter('sam')
  const status = await adapter.getStatus({ db })
  assert.equal(status.installed, true)
  // When sam_runs doesn't exist, last_run_at stays null and health is 'idle'
  assert.equal(status.last_run_at, null)
  assert.equal(status.health, 'idle')
})

test('Hamilton adapter exposes open_blockers + queue_depth (best-effort)', async () => {
  resetRegistry()
  const db = makeDb()
  const adapter = getAdapter('hamilton')
  const status = await adapter.getStatus({ db })
  assert.equal(status.agent_name, 'hamilton')
  assert.equal(typeof status.queue_depth, 'number')
  assert.equal(typeof status.open_blockers, 'number')
})

test('Yana adapter is the LEAD-DISCOVERY agent, separate from Hamilton', async () => {
  resetRegistry()
  const yana = getAdapter('yana')
  const hamilton = getAdapter('hamilton')
  assert.equal(yana.tagline, 'Client Discovery (lead intelligence)')
  assert.equal(hamilton.tagline, 'Application Autopilot / Funding Completion')
  assert.notEqual(yana.constructor.name, hamilton.constructor.name)
})
