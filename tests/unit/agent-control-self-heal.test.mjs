/**
 * Regression: Agent Control Center self-heals missing agent tables before
 * running, so a cycle started against a server that booted before the agent
 * migrations landed never hard-fails with
 *   `relation "robert_runs" does not exist`
 * (the production failure observed 2026-06-17T22:09:16).
 *
 * executeRun() calls ensureAgentSubsystemTables(db) right after a run goes
 * `running`, before any adapter executes. This test starts a full_cycle on a
 * DB that has NO agent telemetry/run tables and asserts they exist afterward
 * and the run did not fail.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import { startRun } from '../../backend/services/agentControl/agentControlOrchestrator.js'
import { _resetSchemaCache, getRun } from '../../backend/services/agentControl/agentControlStore.js'
import { setAdapter, resetRegistry } from '../../backend/services/agentControl/agentAdapters/agentAdapterRegistry.js'
import { BaseAgentAdapter } from '../../backend/services/agentControl/agentAdapters/baseAgentAdapter.js'
import { _resetAdminAccountCache } from '../../backend/services/hamilton/hamiltonAdminAccount.js'
import { _resetNotificationsSchemaCache } from '../../backend/services/agentControl/agentControlNotifications.js'

const ADMIN_EMAIL = 'admin@grantflow.local'

// A Robert-flavoured adapter whose start() writes a real row into robert_runs
// via the real store — this is exactly the path that threw in production when
// the table was missing.
class RobertLikeAdapter extends BaseAgentAdapter {
  async getStatus() { return { agent_name: this.name, health: 'idle' } }
  async start({ db, controlRunId } = {}) {
    const { startRun: startRobertRun, completeRun } = await import('../../backend/services/robert/robertRunStore.js')
    // Valid CHECK-constrained values (mode/trigger/status enums on robert_runs).
    const runId = await startRobertRun(db, { mode: 'observe', trigger: 'admin-ui' })
    await completeRun(db, runId, { status: 'completed', summary: {} })
    return { ok: true, status: 'completed', summary: { agent: this.name, run_id: controlRunId } }
  }
  async stop() { return { ok: true, partial: false } }
}

class NoopAdapter extends BaseAgentAdapter {
  async getStatus() { return { agent_name: this.name, health: 'idle' } }
  async start({ controlRunId } = {}) {
    return { ok: true, status: 'completed', summary: { agent: this.name, run_id: controlRunId } }
  }
  async stop() { return { ok: true, partial: false } }
}

function makeDb() {
  const sqlite = new Database(':memory:')
  // Intentionally only the base tables — NO agent telemetry/run tables.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, display_name TEXT, primary_email TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0, role TEXT
    );
  `)
  sqlite.prepare('INSERT INTO users (id, primary_email, is_admin, role) VALUES (?, ?, 1, ?)')
    .run('u_admin', ADMIN_EMAIL, 'admin')
  return wrapSqlite(sqlite)
}

function tableExists(db, name) {
  return Boolean(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

beforeEach(() => {
  resetRegistry()
  _resetSchemaCache()
  _resetAdminAccountCache()
  _resetNotificationsSchemaCache()
})

describe('Agent Control Center self-heal', () => {
  it('creates missing agent tables and runs Robert without "relation does not exist"', async () => {
    const db = makeDb()
    setAdapter('sam', new NoopAdapter({ name: 'sam' }))
    setAdapter('robert', new RobertLikeAdapter({ name: 'robert' }))
    setAdapter('yana', new NoopAdapter({ name: 'yana' }))
    setAdapter('john', new NoopAdapter({ name: 'john' }))
    setAdapter('hamilton', new NoopAdapter({ name: 'hamilton' }))

    // Precondition: robert_runs really is absent before the run.
    assert.equal(tableExists(db, 'robert_runs'), false, 'robert_runs should be absent before the run')

    const { run } = await startRun(db, {
      runType: 'full_cycle',
      user: {
        userId: 'u_admin',
        email: ADMIN_EMAIL,
        role: 'admin',
        is_admin: 1,
        controlCenterAuthorized: true,
      },
    })
    // startRun launches the executor asynchronously. Wait for that canonical
    // executor instead of racing it with a second executeRun call that correctly
    // loses the per-run lease.
    const terminal = new Set(['completed', 'completed_noop', 'completed_with_errors', 'failed', 'stopped', 'cancelled', 'canceled'])
    const deadline = Date.now() + 3_000
    let finished = await getRun(db, run.id)
    while (!terminal.has(finished?.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      finished = await getRun(db, run.id)
    }
    assert.ok(terminal.has(finished?.status), `run did not finish before timeout (status=${finished?.status})`)

    // Self-heal created the agent tables...
    assert.equal(tableExists(db, 'robert_runs'), true, 'robert_runs must exist after the run self-heals')
    assert.equal(tableExists(db, 'sam_runs'), true)
    assert.equal(tableExists(db, 'agent_control_runs'), true)

    // ...and the run did not fail on a missing relation.
    assert.notEqual(finished.status, 'failed', `run should not fail; got ${finished.status} (${finished.error || 'no error'})`)

    // Robert actually persisted a run row.
    const robertRows = db.raw.prepare('SELECT COUNT(*) AS n FROM robert_runs').get()
    assert.equal(robertRows.n >= 1, true, 'Robert should have written a robert_runs row')
  })
})
