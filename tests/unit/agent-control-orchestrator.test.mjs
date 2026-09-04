/**
 * Admin Agent Control Center orchestrator tests.
 *
 * Covers:
 *   - admin gating (only a canonical-context-authorized operator can start)
 *   - run creation: full_cycle / selected_agents / *_only
 *   - ordered step plan (sam preflight → robert → yana → john → hamilton → sam postflight)
 *   - graceful_stop / pause / resume / cancel / emergency_stop semantics
 *   - single-flight lock for full_cycle
 *   - lifecycle notifications routed to canonical admin
 *   - stop_on_critical_sam_finding short-circuits the cycle
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  startRun,
  pauseRun,
  resumeRun,
  stopRun,
  stopAgent,
  emergencyStopRun,
  cancelRun,
  executeRun,
  getControlCenterStatus,
  getCanonicalAdminEmail,
  authorizeControlCenterUser,
  isControlCenterAdmin,
} from '../../backend/services/agentControl/agentControlOrchestrator.js'
import {
  _resetSchemaCache,
  ensureSchema,
  getRun,
  listSteps,
  listEvents,
  recordStopRequest,
  latestUnfulfilledStop,
  listStopRequests,
} from '../../backend/services/agentControl/agentControlStore.js'
import { setAdapter, resetRegistry } from '../../backend/services/agentControl/agentAdapters/agentAdapterRegistry.js'
import { BaseAgentAdapter } from '../../backend/services/agentControl/agentAdapters/baseAgentAdapter.js'
import { _resetAdminAccountCache } from '../../backend/services/hamilton/hamiltonAdminAccount.js'
import { _resetNotificationsSchemaCache } from '../../backend/services/agentControl/agentControlNotifications.js'

const ADMIN_EMAIL = 'admin@grantflow.local'
const NON_ADMIN = 'someone@example.com'
const TERMINAL_RUN_STATES = new Set([
  'completed',
  'completed_noop',
  'failed',
  'cancelled',
  'stopped',
  'partial_stop',
  'stop_failed',
])

class MockAdapter extends BaseAgentAdapter {
  constructor(name, behaviour = {}) {
    super({ name })
    this.behaviour = behaviour
    this.startCallCount = 0
    this.stopCallCount = 0
    this.lastSignal = null
  }

  async getStatus() { return { agent_name: this.name, health: 'idle', queue_depth: 0 } }

  async start({ controlRunId, signal, options } = {}) {
    this.startCallCount += 1
    this.lastSignal = signal
    if (typeof this.behaviour.start === 'function') {
      return this.behaviour.start({ controlRunId, signal, options })
    }
    return this.behaviour.startResult || {
      ok: true,
      status: 'completed',
      // Report one unit of real work so honest-completion accounting
      // (orchestrator countAgentWork) marks the run `completed` rather than
      // `completed_noop`. Superset of the per-agent fields it recognises; the
      // dedicated no-work / completed_noop path is covered separately in
      // agent-control-telemetry.test.mjs.
      summary: {
        agent: this.name,
        run_id: controlRunId,
        findings_total: 1,
        candidates_inserted: 1,
        candidates_qualified: 1,
        drafts_created: 1,
        processed: 1,
        interactions: 1,
      },
    }
  }

  async stop() { this.stopCallCount += 1; return { ok: true, partial: false } }
}

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_email TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      role TEXT
    );
  `)
  sqlite.prepare('INSERT INTO users (id, primary_email, is_admin, role) VALUES (?, ?, 1, ?)').run('u_admin', ADMIN_EMAIL, 'admin')

  return wrapSqlite(sqlite)
}

function adminUser() {
  return {
    userId: 'u_admin',
    email: ADMIN_EMAIL,
    role: 'admin',
    is_admin: 1,
    controlCenterAuthorized: true,
  }
}

function nonAdminUser() {
  return { userId: 'u_other', email: NON_ADMIN, role: 'user' }
}

async function readNotifications(db, type = null) {
  try {
    const rows = type
      ? await db.prepare('SELECT * FROM notifications WHERE type = ? ORDER BY created_at').all(type)
      : await db.prepare('SELECT * FROM notifications ORDER BY created_at').all()
    return rows.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : {} }))
  } catch { return [] }
}

function installMockAdapters(behaviours = {}) {
  const mocks = {
    sam: new MockAdapter('sam', behaviours.sam || {}),
    robert: new MockAdapter('robert', behaviours.robert || {}),
    yana: new MockAdapter('yana', behaviours.yana || {}),
    john: new MockAdapter('john', behaviours.john || {}),
    hamilton: new MockAdapter('hamilton', behaviours.hamilton || {}),
  }
  for (const [name, adapter] of Object.entries(mocks)) setAdapter(name, adapter)
  return mocks
}

async function waitForRunTerminal(db, runId, { timeoutMs = 2_000, pollMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await getRun(db, runId)
    if (run && TERMINAL_RUN_STATES.has(run.status)) return run
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  const current = await getRun(db, runId)
  throw new Error(`agent-control run ${runId} did not reach a terminal state within ${timeoutMs}ms (status=${current?.status || 'missing'})`)
}

beforeEach(() => {
  resetRegistry()
  _resetSchemaCache()
  _resetAdminAccountCache()
  _resetNotificationsSchemaCache()
})

describe('Agent Control Center — admin gating', () => {
  it(`canonical admin email matches ${ADMIN_EMAIL}`, () => {
    assert.equal(getCanonicalAdminEmail(), ADMIN_EMAIL)
  })

  it('raw token email or role never authorizes the control center', () => {
    assert.equal(isControlCenterAdmin({ email: ADMIN_EMAIL }), false)
    assert.equal(isControlCenterAdmin({ primary_email: ADMIN_EMAIL }), false)
    assert.equal(isControlCenterAdmin({ email: ADMIN_EMAIL, role: 'admin', is_admin: 1 }), false)
    assert.equal(isControlCenterAdmin({ email: NON_ADMIN, role: 'admin', is_admin: 1 }), false)
    assert.equal(isControlCenterAdmin(null), false)
  })

  it('authorizes only the configured operator from resolved DB context', () => {
    const user = { userId: 'u_admin', email: 'stale-token@example.com', role: 'admin' }
    const trusted = authorizeControlCenterUser(user, {
      userId: 'u_admin',
      identityResolved: true,
      isAdmin: true,
      email: ADMIN_EMAIL,
    })
    assert.equal(isControlCenterAdmin(trusted), true)
    assert.equal(trusted.email, ADMIN_EMAIL)
    assert.equal(authorizeControlCenterUser(user, {
      identityResolved: true,
      isAdmin: false,
      email: ADMIN_EMAIL,
    }), null)
    assert.equal(authorizeControlCenterUser(user, {
      identityResolved: true,
      isAdmin: true,
      email: NON_ADMIN,
    }), null)
    assert.equal(authorizeControlCenterUser(user, null), null)
  })

  it('non-admin cannot start a run', async () => {
    const db = makeDb()
    await ensureSchema(db)
    installMockAdapters()
    await assert.rejects(
      () => startRun(db, { runType: 'full_cycle', user: nonAdminUser() }),
      /admin/i,
    )
  })

  it('canonical admin can start a full_cycle', async () => {
    const db = makeDb()
    installMockAdapters()
    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    assert.equal(run.run_type, 'full_cycle')
    assert.deepEqual(run.requested_agents, ['sam', 'robert', 'yana', 'john', 'hamilton'])
  })
})

describe('Agent Control Center — full_cycle ordering', () => {
  it('builds steps in order: sam preflight → robert → yana → john → hamilton → sam postflight', async () => {
    const db = makeDb()
    installMockAdapters()
    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    // Wait for execution to complete.
    await new Promise((r) => setTimeout(r, 50))
    const steps = await listSteps(db, run.id)
    const names = steps.map((s) => `${s.agent_name}:${s.step_name}`)
    assert.deepEqual(names, [
      'sam:sam_preflight',
      'robert:robert_main',
      'yana:yana_main',
      'john:john_main',
      'hamilton:hamilton_main',
      'sam:sam_postflight',
    ])
  })

  it('full_cycle completes when every adapter returns ok', async () => {
    const db = makeDb()
    installMockAdapters()
    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    await new Promise((r) => setTimeout(r, 80))
    const finalRun = await getRun(db, run.id)
    assert.equal(finalRun.status, 'completed')
    const steps = await listSteps(db, run.id)
    for (const s of steps) {
      assert.equal(s.status, 'completed', `step ${s.step_name} should be completed`)
    }
  })

  it('selected_agents respects the order even when the user passes a different order', async () => {
    const db = makeDb()
    installMockAdapters()
    const { run } = await startRun(db, {
      runType: 'selected_agents',
      agents: ['hamilton', 'robert', 'yana'],
      user: adminUser(),
    })
    await new Promise((r) => setTimeout(r, 50))
    const steps = await listSteps(db, run.id)
    const names = steps.map((s) => s.agent_name)
    assert.deepEqual(names, ['robert', 'yana', 'hamilton'])
  })

  it('stop_on_critical_sam_finding short-circuits the rest of the cycle', async () => {
    const db = makeDb()
    installMockAdapters({
      sam: { startResult: { ok: true, status: 'blocked', summary: { critical_findings: 2 }, blocked_reason: 'critical findings' } },
    })
    const { run } = await startRun(db, {
      runType: 'full_cycle',
      user: adminUser(),
      options: { stop_on_critical_sam_finding: true },
    })
    await new Promise((r) => setTimeout(r, 80))
    const steps = await listSteps(db, run.id)
    const samStep = steps.find((s) => s.step_name === 'sam_preflight')
    assert.equal(samStep.status, 'blocked')
    const robertStep = steps.find((s) => s.step_name === 'robert_main')
    // Robert should never have started
    assert.notEqual(robertStep.status, 'completed')
  })

  it('failed agent does NOT stop cycle by default; stops when stop_on_agent_failure=true', async () => {
    {
      const db = makeDb()
      installMockAdapters({
        robert: { startResult: { ok: false, status: 'failed', error: 'boom', summary: { error: 'boom' } } },
      })
      const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
      await new Promise((r) => setTimeout(r, 80))
      const steps = await listSteps(db, run.id)
      const after = steps.find((s) => s.step_name === 'yana_main')
      assert.equal(after.status, 'completed', 'yana should still run when stop_on_agent_failure=false (default)')
      const finalRun = await getRun(db, run.id)
      assert.equal(finalRun.status, 'failed', 'a continued cycle must still report its failed step')
    }
    resetRegistry()
    {
      const db = makeDb()
      installMockAdapters({
        robert: { startResult: { ok: false, status: 'failed', error: 'boom', summary: { error: 'boom' } } },
      })
      const { run } = await startRun(db, {
        runType: 'full_cycle',
        user: adminUser(),
        options: { stop_on_agent_failure: true },
      })
      await new Promise((r) => setTimeout(r, 80))
      const finalRun = await getRun(db, run.id)
      assert.equal(finalRun.status, 'failed')
    }
  })
})

describe('Agent Control Center — stop / pause / resume / emergency-stop', () => {
  it('graceful stop prevents the next queued step from starting', async () => {
    const db = makeDb()
    // Make robert hang: it never returns until shouldStop fires.
    let robertEntered = null
    const slowRobert = {
      start: async ({ signal }) => {
        robertEntered = Date.now()
        // Loop, polling shouldStop every 5ms
        while (!signal.shouldStop()) {
          await new Promise((r) => setTimeout(r, 5))
          if (Date.now() - robertEntered > 250) break
        }
        return { ok: true, status: signal.shouldStop() ? 'stopped' : 'completed', summary: {} }
      },
    }
    installMockAdapters({ robert: slowRobert })

    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    // Wait for robert to start.
    await new Promise((r) => setTimeout(r, 50))
    await stopRun(db, run.id, { user: adminUser(), reason: 'admin asked' })
    await new Promise((r) => setTimeout(r, 200))
    const finalRun = await getRun(db, run.id)
    assert.match(finalRun.status, /stopped|stop|cancelled/)
    const steps = await listSteps(db, run.id)
    const yana = steps.find((s) => s.step_name === 'yana_main')
    assert.notEqual(yana.status, 'completed', 'Yana should not have started after stop')
  })

  it('pause sets run status to paused and resume continues from next queued step', async () => {
    const db = makeDb()
    let count = { sam: 0, robert: 0, yana: 0, john: 0, hamilton: 0 }
    installMockAdapters({
      robert: {
        start: async ({ signal }) => {
          count.robert += 1
          // Wait briefly so the pause request can be written before we exit.
          for (let i = 0; i < 5; i += 1) {
            await new Promise((r) => setTimeout(r, 5))
            if (signal.shouldPause()) break
          }
          return { ok: true, status: 'completed', summary: {} }
        },
      },
    })

    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    await new Promise((r) => setTimeout(r, 30))
    await pauseRun(db, run.id, { user: adminUser() })
    await new Promise((r) => setTimeout(r, 100))
    let after = await getRun(db, run.id)
    assert.match(after.status, /paus(ing|ed)/)

    await resumeRun(db, run.id, { user: adminUser() })
    await new Promise((r) => setTimeout(r, 80))
    after = await getRun(db, run.id)
    assert.equal(after.status, 'completed')
  })

  it('a cooperative pause requeues the same durable step on resume', async () => {
    const db = makeDb()
    let starts = 0
    installMockAdapters({
      robert: {
        start: async ({ signal }) => {
          starts += 1
          if (starts === 1) {
            for (let i = 0; i < 100; i += 1) {
              await new Promise((r) => setTimeout(r, 5))
              if (signal.shouldPause()) {
                return { ok: true, status: 'paused', summary: { agent: 'robert', paused: true } }
              }
            }
          }
          return {
            ok: true,
            status: 'completed',
            summary: { agent: 'robert', candidates_inserted: 1 },
          }
        },
      },
    })

    const { run } = await startRun(db, { runType: 'robert_only', user: adminUser() })
    await new Promise((r) => setTimeout(r, 25))
    await pauseRun(db, run.id, { user: adminUser() })
    await new Promise((r) => setTimeout(r, 140))

    let current = await getRun(db, run.id)
    let [step] = await listSteps(db, run.id)
    assert.equal(current.status, 'paused')
    assert.equal(step.status, 'paused')
    assert.equal(starts, 1)

    await resumeRun(db, run.id, { user: adminUser() })
    await new Promise((r) => setTimeout(r, 140))

    current = await getRun(db, run.id)
    ;[step] = await listSteps(db, run.id)
    assert.equal(current.status, 'completed')
    assert.equal(step.status, 'completed')
    assert.equal(starts, 2)
  })

  it('an agent-scoped stop halts only that agent and the full cycle continues', async () => {
    const db = makeDb()
    installMockAdapters({
      robert: {
        start: async ({ signal }) => {
          for (let i = 0; i < 100; i += 1) {
            await new Promise((r) => setTimeout(r, 5))
            if (signal.shouldStop()) {
              return { ok: true, status: 'stopped', summary: { agent: 'robert', stopped: true } }
            }
          }
          return { ok: true, status: 'completed', summary: { candidates_inserted: 1 } }
        },
      },
    })

    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    await new Promise((r) => setTimeout(r, 35))
    await stopAgent(db, 'robert', { user: adminUser(), reason: 'stop Robert only' })
    await new Promise((r) => setTimeout(r, 260))

    const steps = await listSteps(db, run.id)
    assert.equal(steps.find((s) => s.step_name === 'robert_main')?.status, 'stopped')
    assert.equal(steps.find((s) => s.step_name === 'yana_main')?.status, 'completed')
    assert.equal((await getRun(db, run.id)).status, 'completed')
  })

  it('emergency stop marks queued steps stopped immediately', async () => {
    const db = makeDb()
    installMockAdapters({
      sam: {
        start: async ({ signal }) => {
          // Hold until stop arrives.
          for (let i = 0; i < 50; i += 1) {
            await new Promise((r) => setTimeout(r, 5))
            if (signal.shouldStop()) return { ok: true, status: 'stopped', summary: {} }
          }
          return { ok: true, status: 'completed', summary: {} }
        },
      },
    })
    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    await new Promise((r) => setTimeout(r, 30))
    await emergencyStopRun(db, run.id, { user: adminUser(), reason: 'panic' })
    await new Promise((r) => setTimeout(r, 200))
    const steps = await listSteps(db, run.id)
    const queued = steps.find((s) => s.agent_name === 'hamilton')
    assert.match(queued.status, /stopped|skipped/)
    const events = await listEvents(db, run.id, { limit: 100, eventType: 'control.run.emergency_stop' })
    assert.equal(events.length >= 1, true)
  })

  it('rejects lifecycle commands after a run is terminal without writing requests', async () => {
    const db = makeDb()
    installMockAdapters()
    const { run } = await startRun(db, { runType: 'sam_only', user: adminUser() })
    await new Promise((r) => setTimeout(r, 80))
    assert.equal((await getRun(db, run.id)).status, 'completed')

    const commands = [
      () => pauseRun(db, run.id, { user: adminUser() }),
      () => resumeRun(db, run.id, { user: adminUser() }),
      () => stopRun(db, run.id, { user: adminUser() }),
      () => emergencyStopRun(db, run.id, { user: adminUser() }),
      () => cancelRun(db, run.id, { user: adminUser() }),
    ]
    for (const command of commands) {
      await assert.rejects(command, (error) =>
        error?.status === 409 && error?.code === 'invalid_run_transition',
      )
    }
    assert.equal((await getRun(db, run.id)).status, 'completed')
    assert.deepEqual(await listStopRequests(db, run.id), [])
  })

  it('cancel marks queued steps skipped and finalises the run as cancelled', async () => {
    const db = makeDb()
    installMockAdapters({
      sam: {
        start: async ({ signal }) => {
          for (let i = 0; i < 30; i += 1) {
            await new Promise((r) => setTimeout(r, 5))
            if (signal.shouldStop()) return { ok: true, status: 'stopped', summary: {} }
          }
          return { ok: true, status: 'completed', summary: {} }
        },
      },
    })
    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    await new Promise((r) => setTimeout(r, 25))
    await cancelRun(db, run.id, { user: adminUser(), reason: 'admin cancelled' })
    await new Promise((r) => setTimeout(r, 200))
    const finalRun = await getRun(db, run.id)
    assert.equal(finalRun.status, 'cancelled')
    const steps = await listSteps(db, run.id)
    for (const s of steps) {
      assert.notEqual(s.status, 'queued', 'no step should remain queued after cancel')
    }
  })
})

describe('Agent Control Center — single-flight + locks', () => {
  it('rejects a second full_cycle while one is active', async () => {
    const db = makeDb()
    installMockAdapters({
      sam: {
        start: async ({ signal }) => {
          // hold open
          for (let i = 0; i < 30; i += 1) {
            await new Promise((r) => setTimeout(r, 10))
            if (signal.shouldStop()) return { ok: true, status: 'stopped', summary: {} }
          }
          return { ok: true, status: 'completed', summary: {} }
        },
      },
    })
    await startRun(db, { runType: 'full_cycle', user: adminUser() })
    await new Promise((r) => setTimeout(r, 30))
    await assert.rejects(
      () => startRun(db, { runType: 'full_cycle', user: adminUser() }),
      /already in progress|Lock/i,
    )
  })
})

describe('Agent Control Center — notifications + status', () => {
  it('emits agent_control_started + agent_control_completed for the canonical admin', async () => {
    const db = makeDb()
    installMockAdapters()
    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    await new Promise((r) => setTimeout(r, 100))
    const finalRun = await getRun(db, run.id)
    assert.equal(finalRun.status, 'completed')
    const started = await readNotifications(db, 'agent_control_started')
    const done = await readNotifications(db, 'agent_control_completed')
    assert.equal(started.length, 1)
    assert.equal(started[0].user_id, 'u_admin')
    assert.equal(done.length, 1)
  })

  it('getControlCenterStatus includes the active run + every adapter snapshot', async () => {
    const db = makeDb()
    installMockAdapters({
      sam: {
        start: async ({ signal }) => {
          for (let i = 0; i < 10; i += 1) {
            await new Promise((r) => setTimeout(r, 10))
            if (signal.shouldStop()) return { ok: true, status: 'stopped', summary: {} }
          }
          return { ok: true, status: 'completed', summary: {} }
        },
      },
    })
    const { run } = await startRun(db, { runType: 'full_cycle', user: adminUser() })
    await new Promise((r) => setTimeout(r, 25))
    const status = await getControlCenterStatus(db)
    assert.equal(status.admin_email, ADMIN_EMAIL)
    assert.ok(status.active_run)
    assert.equal(status.active_run.id, run.id)
    // STATUS_AGENTS = the 5 canonical full-cycle agents + anya (status-only,
    // surfaced for observability but never driven by the automated cycle).
    assert.deepEqual(Object.keys(status.agents).sort(), ['anya', 'hamilton', 'john', 'robert', 'sam', 'yana'])
    // Cleanup so the in-flight sam adapter loop doesn't run forever.
    await emergencyStopRun(db, run.id, { user: adminUser() })
    await new Promise((r) => setTimeout(r, 150))
  })
})

describe('Agent Control Center — store helpers', () => {
  it('ensureSchema retries after a transient DDL failure and caches only success', async () => {
    _resetSchemaCache()
    let failedOnce = false
    let runTableAttempts = 0
    const db = {
      prepare(sql) {
        return {
          async run() {
            if (/CREATE TABLE IF NOT EXISTS agent_control_runs\s*\(/i.test(sql)) {
              runTableAttempts += 1
              if (!failedOnce) {
                failedOnce = true
                throw new Error('transient ddl failure')
              }
            }
            return { changes: 0 }
          },
        }
      },
    }

    await ensureSchema(db)
    await ensureSchema(db)
    await ensureSchema(db)
    assert.equal(runTableAttempts, 2)
  })

  it('run-wide stop polling ignores an agent-scoped stop', async () => {
    const db = makeDb()
    await ensureSchema(db)
    await recordStopRequest(db, {
      controlRunId: 'run-scoped-stop',
      agentName: 'robert',
      requestType: 'graceful_stop',
    })
    assert.equal(
      await latestUnfulfilledStop(db, 'run-scoped-stop', { runWideOnly: true }),
      null,
    )
    assert.equal(
      (await latestUnfulfilledStop(db, 'run-scoped-stop', { agentName: 'robert' }))?.request_type,
      'graceful_stop',
    )
  })

  it('latestUnfulfilledStop respects priority: emergency > cancel > graceful_stop > pause', async () => {
    const db = makeDb()
    await ensureSchema(db)
    const runId = 'run_test'
    await recordStopRequest(db, { controlRunId: runId, requestType: 'pause' })
    let r = await latestUnfulfilledStop(db, runId)
    assert.equal(r?.request_type, 'pause')
    await recordStopRequest(db, { controlRunId: runId, requestType: 'graceful_stop' })
    r = await latestUnfulfilledStop(db, runId)
    assert.equal(r?.request_type, 'graceful_stop')
    await recordStopRequest(db, { controlRunId: runId, requestType: 'cancel' })
    r = await latestUnfulfilledStop(db, runId)
    assert.equal(r?.request_type, 'cancel')
    await recordStopRequest(db, { controlRunId: runId, requestType: 'emergency_stop' })
    r = await latestUnfulfilledStop(db, runId)
    assert.equal(r?.request_type, 'emergency_stop')
  })
})

describe('Agent Control Center — adapter signal contract', () => {
  it('signal.heartbeat updates step row + signal.recordEvent writes events', async () => {
    const db = makeDb()
    installMockAdapters({
      sam: {
        start: async ({ signal }) => {
          await signal.heartbeat({ phase: 'pre' })
          await signal.recordEvent({ eventType: 'agent.sam.test', message: 'hello' })
          return { ok: true, status: 'completed', summary: {} }
        },
      },
    })
    const { run } = await startRun(db, { runType: 'sam_only', user: adminUser() })
    await new Promise((r) => setTimeout(r, 80))
    const events = await listEvents(db, run.id, { limit: 50 })
    assert.equal(events.some((e) => e.event_type === 'agent.sam.test'), true)
    const steps = await listSteps(db, run.id)
    assert.ok(steps.some((s) => s.heartbeat_at))
  })
})

describe('Agent Control Center — executeRun is idempotent on re-entry', () => {
  it('concurrent executor kicks cannot duplicate any sam_only phase', async () => {
    const db = makeDb()
    const mocks = installMockAdapters({
      sam: {
        start: async () => {
          await new Promise((r) => setTimeout(r, 120))
          return { ok: true, status: 'completed', summary: { findings_total: 1 } }
        },
      },
    })
    const { run } = await startRun(db, { runType: 'sam_only', user: adminUser() })
    await new Promise((r) => setTimeout(r, 20))
    await Promise.all([
      executeRun({ db, runId: run.id }),
      executeRun({ db, runId: run.id }),
      executeRun({ db, runId: run.id }),
    ])
    await waitForRunTerminal(db, run.id)
    // sam_only deliberately runs preflight, main, and postflight. Re-entry must
    // not add a fourth invocation of any phase.
    assert.equal(mocks.sam.startCallCount, 3)
  })

  it('re-invoking executeRun on a finished run does not re-run steps', async () => {
    const db = makeDb()
    const mocks = installMockAdapters()
    const { run } = await startRun(db, { runType: 'sam_only', user: adminUser() })
    await new Promise((r) => setTimeout(r, 50))
    const before = mocks.sam.startCallCount
    await executeRun({ db, runId: run.id })
    assert.equal(mocks.sam.startCallCount, before, 'sam adapter should not start twice')
  })
})
