/**
 * Admin Agent Control Center route tests.
 *
 * Mounts the real router behind a fake auth middleware that injects
 * either the canonical admin (buckeye7066@gmail.com), a different
 * admin email, or a non-admin user. Validates:
 *
 *   - non-admin → 403 on every route
 *   - admin email mismatch → 403 (only canonical admin counts)
 *   - canonical admin can read /status, list runs, start a run, and
 *     stop / pause / resume / cancel / emergency-stop it
 *   - 400 on invalid run_type / agent
 *   - lock contention → 409 on concurrent full_cycle
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import controlRouter from '../../backend/routes/adminAgentControl.js'
import { setAdapter, resetRegistry } from '../../backend/services/agentControl/agentAdapters/agentAdapterRegistry.js'
import { BaseAgentAdapter } from '../../backend/services/agentControl/agentAdapters/baseAgentAdapter.js'
import { _resetSchemaCache } from '../../backend/services/agentControl/agentControlStore.js'
import { _resetAdminAccountCache } from '../../backend/services/hamilton/hamiltonAdminAccount.js'
import { _resetNotificationsSchemaCache } from '../../backend/services/agentControl/agentControlNotifications.js'

const ADMIN_EMAIL = 'buckeye7066@gmail.com'

class TrivialAdapter extends BaseAgentAdapter {
  constructor(name) { super({ name }) }
  async start({ controlRunId } = {}) {
    // Report one unit of real work so honest-completion accounting marks the
    // run `completed` (not `completed_noop`). Superset of the per-agent fields
    // the orchestrator's countAgentWork() recognises.
    return {
      ok: true,
      status: 'completed',
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
}

function freshAdapters() {
  for (const n of ['sam', 'robert', 'yana', 'john', 'hamilton']) {
    setAdapter(n, new TrivialAdapter(n))
  }
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
  sqlite.prepare('INSERT INTO users (id, primary_email, is_admin, role) VALUES (?, ?, 1, ?)')
    .run('u_admin', ADMIN_EMAIL, 'admin')
  return wrapSqlite(sqlite)
}

function startApp({ db, user }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    if (user) req.user = user
    next()
  })
  app.use('/api/admin/agent-control', controlRouter)
  const server = app.listen(0)
  return server
}

function request(server, method, path, body = null) {
  const port = server.address().port
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        let buf = ''
        res.on('data', (c) => { buf += c })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }) }
          catch (err) { resolve({ status: res.statusCode, body: buf, parseError: err }) }
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function adminSession() {
  return { userId: 'u_admin', email: ADMIN_EMAIL, role: 'admin', is_admin: 1 }
}
function otherAdminSession() {
  return { userId: 'u_other_admin', email: 'someoneelse@grantflow.app', role: 'admin', is_admin: 1 }
}
function nonAdminSession() {
  return { userId: 'u_other', email: 'user@example.com', role: 'user' }
}

test.beforeEach(() => {
  resetRegistry()
  _resetSchemaCache()
  _resetAdminAccountCache()
  _resetNotificationsSchemaCache()
  freshAdapters()
})

test('non-admin gets 403 on /status', async () => {
  const db = makeDb()
  const server = startApp({ db, user: nonAdminSession() })
  try {
    const r = await request(server, 'GET', '/api/admin/agent-control/status')
    assert.equal(r.status, 403)
    assert.equal(r.body?.ok, false)
  } finally { server.close() }
})

test('a different admin email also gets 403 (single canonical admin)', async () => {
  const db = makeDb()
  const server = startApp({ db, user: otherAdminSession() })
  try {
    const r = await request(server, 'GET', '/api/admin/agent-control/status')
    assert.equal(r.status, 403)
    assert.match(r.body?.error || '', /agent_control_admin_only/)
  } finally { server.close() }
})

test('canonical admin can call /status and gets adapter snapshot', async () => {
  const db = makeDb()
  const server = startApp({ db, user: adminSession() })
  try {
    const r = await request(server, 'GET', '/api/admin/agent-control/status')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.canonical_admin, ADMIN_EMAIL)
    assert.deepEqual(Object.keys(r.body.agents).sort(), ['hamilton', 'john', 'robert', 'sam', 'yana'])
    assert.deepEqual(r.body.available_agents.sort(), ['hamilton', 'john', 'robert', 'sam', 'yana'])
  } finally { server.close() }
})

test('canonical admin can start full_cycle, see steps in order, and run completes', async () => {
  const db = makeDb()
  const server = startApp({ db, user: adminSession() })
  try {
    const r = await request(server, 'POST', '/api/admin/agent-control/start', { run_type: 'full_cycle' })
    assert.equal(r.status, 202)
    assert.equal(r.body.ok, true)
    const runId = r.body.run.id
    const stepNames = (r.body.steps || []).map((s) => s.step_name)
    assert.deepEqual(stepNames, ['sam_preflight', 'robert_main', 'yana_main', 'john_main', 'hamilton_main', 'sam_postflight'])
    // Allow execution to complete
    await new Promise((resolve) => setTimeout(resolve, 80))
    const r2 = await request(server, 'GET', `/api/admin/agent-control/runs/${runId}`)
    assert.equal(r2.body.run.status, 'completed')
  } finally { server.close() }
})

test('start rejects invalid run_type with 400', async () => {
  const db = makeDb()
  const server = startApp({ db, user: adminSession() })
  try {
    const r = await request(server, 'POST', '/api/admin/agent-control/start', { run_type: 'invalid' })
    assert.equal(r.status, 400)
    assert.equal(r.body?.ok, false)
  } finally { server.close() }
})

test('cannot start two full_cycles concurrently', async () => {
  const db = makeDb()
  // A slow Sam keeps the run open long enough to hit the lock
  const slow = new BaseAgentAdapter({ name: 'sam' })
  slow.start = async ({ signal }) => {
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
      if (signal.shouldStop()) return { ok: true, status: 'stopped', summary: {} }
    }
    return { ok: true, status: 'completed', summary: {} }
  }
  setAdapter('sam', slow)
  const server = startApp({ db, user: adminSession() })
  try {
    const a = await request(server, 'POST', '/api/admin/agent-control/start', { run_type: 'full_cycle' })
    assert.equal(a.status, 202)
    await new Promise((r) => setTimeout(r, 30))
    const b = await request(server, 'POST', '/api/admin/agent-control/start', { run_type: 'full_cycle' })
    assert.equal(b.status, 409)
    // Cleanup the still-running run
    await request(server, 'POST', `/api/admin/agent-control/runs/${a.body.run.id}/emergency-stop`, { reason: 'cleanup' })
    await new Promise((r) => setTimeout(r, 200))
  } finally { server.close() }
})

test('per-agent stop endpoint returns 400 for invalid agent', async () => {
  const db = makeDb()
  const server = startApp({ db, user: adminSession() })
  try {
    const r = await request(server, 'POST', '/api/admin/agent-control/agents/larry/stop', { reason: 'no' })
    assert.equal(r.status, 400)
  } finally { server.close() }
})

test('admin can pause and resume a run', async () => {
  const db = makeDb()
  const server = startApp({ db, user: adminSession() })
  try {
    // With trivial adapters everything finishes immediately, so we
    // pre-create a run and exercise the pause/resume endpoints
    // independently of the executor's race window.
    const start = await request(server, 'POST', '/api/admin/agent-control/start', { run_type: 'full_cycle' })
    const runId = start.body.run.id
    const pause = await request(server, 'POST', `/api/admin/agent-control/runs/${runId}/pause`, { reason: 'test pause' })
    assert.equal(pause.status, 200)
    assert.equal(pause.body.ok, true)
    const resume = await request(server, 'POST', `/api/admin/agent-control/runs/${runId}/resume`)
    assert.equal(resume.status, 200)
    assert.equal(resume.body.ok, true)
    await new Promise((r) => setTimeout(r, 100))
    // After resume the run drives to its terminal state; either the
    // run has already completed or pause arrived after completion —
    // both outcomes are acceptable here. We only assert that the
    // endpoints accept the requests and return ok.
  } finally { server.close() }
})

test('admin emergency-stop transitions a run away from running', async () => {
  const db = makeDb()
  const slow = new BaseAgentAdapter({ name: 'sam' })
  slow.start = async ({ signal }) => {
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
      if (signal.shouldStop()) return { ok: true, status: 'stopped', summary: {} }
    }
    return { ok: true, status: 'completed', summary: {} }
  }
  setAdapter('sam', slow)

  const server = startApp({ db, user: adminSession() })
  try {
    const start = await request(server, 'POST', '/api/admin/agent-control/start', { run_type: 'full_cycle' })
    const runId = start.body.run.id
    await new Promise((r) => setTimeout(r, 30))

    const stop = await request(server, 'POST', `/api/admin/agent-control/runs/${runId}/emergency-stop`, { reason: 'test' })
    assert.equal(stop.status, 200)
    // Wait for the slow adapter loop to notice shouldStop() and exit.
    await new Promise((r) => setTimeout(r, 600))
    const final = await request(server, 'GET', `/api/admin/agent-control/runs/${runId}`)
    assert.match(final.body.run.status, /stopped|partial_stop|stopping|cancelled/)
  } finally { server.close() }
})

test('admin can cancel a run', async () => {
  const db = makeDb()
  const slow = new BaseAgentAdapter({ name: 'sam' })
  slow.start = async ({ signal }) => {
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
      if (signal.shouldStop()) return { ok: true, status: 'stopped', summary: {} }
    }
    return { ok: true, status: 'completed', summary: {} }
  }
  setAdapter('sam', slow)
  const server = startApp({ db, user: adminSession() })
  try {
    const start = await request(server, 'POST', '/api/admin/agent-control/start', { run_type: 'full_cycle' })
    const runId = start.body.run.id
    await new Promise((r) => setTimeout(r, 25))
    const cancel = await request(server, 'POST', `/api/admin/agent-control/runs/${runId}/cancel`, { reason: 'test cancel' })
    assert.equal(cancel.status, 200)
    assert.equal(cancel.body.run.status, 'cancelled')
    await new Promise((r) => setTimeout(r, 600))
    const final = await request(server, 'GET', `/api/admin/agent-control/runs/${runId}`)
    assert.equal(final.body.run.status, 'cancelled')
  } finally { server.close() }
})
