import Database from 'better-sqlite3'
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import router, {
  launchParityRun,
  pendingWebParity,
  snapshotState,
} from '../routes/webParityAdmin.js'
import { ensureSchema } from '../services/agentControl/agentControlStore.js'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
  return db
}

function makeApp(db, { admin = true } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.ctx = { isAdmin: admin, email: admin ? 'owner@example.com' : 'user@example.com' }
    next()
  })
  app.use('/api/admin/web-parity', router)
  return app
}

describe('web parity background admin route', () => {
  it('filters only pending benchmark-owned queue entries', () => {
    expect(pendingWebParity([
      { source: 'web_parity_benchmark', status: 'candidate', url: 'https://a.example' },
      { source: 'web_parity_benchmark', status: 'adopted', url: 'https://b.example' },
      { source: 'condition_source_search', status: 'candidate', url: 'https://c.example' },
    ])).toEqual([
      { source: 'web_parity_benchmark', status: 'candidate', url: 'https://a.example' },
    ])
  })

  it('counts a not-evaluated (still re-seedable) candidate as pending, never an exhausted or judged one', () => {
    // 2026-09-12: a seed the gates could not EVALUATE (dead LLM route, fetch
    // failure) is `not_evaluated:<class>` and stays eligible for re-seeding —
    // hiding it from "pending" would read the queue as drained while the
    // owner rule's backlog is still open. Exhausted / adopted / gated_out are
    // verdicts (or bounded give-ups) and are not pending.
    expect(pendingWebParity([
      { source: 'web_parity_benchmark', status: 'candidate', url: 'https://a.example' },
      { source: 'web_parity_benchmark', status: 'not_evaluated:extraction_failed', url: 'https://b.example' },
      { source: 'web_parity_benchmark', status: 'not_evaluated:fetch_failed', url: 'https://c.example' },
      { source: 'web_parity_benchmark', status: 'not_evaluated:exhausted', url: 'https://d.example' },
      { source: 'web_parity_benchmark', status: 'gated_out', url: 'https://e.example' },
      { source: 'web_parity_benchmark', status: 'adopted', url: 'https://f.example' },
    ]).map((entry) => entry.url)).toEqual(['https://a.example', 'https://b.example', 'https://c.example'])
  })

  it('returns the durable latest benchmark and queue without starting work', async () => {
    const db = makeDb()
    const latest = {
      generated_at: '2026-07-30T02:00:00.000Z',
      fleet_parity: 88.5,
      per_profile: [{ profile_id: 'p1', parity: 88.5 }],
    }
    db.prepare('INSERT INTO system_kv (key,value,updated_at) VALUES (?,?,?)').run(
      'web_parity_benchmark',
      JSON.stringify({ generated_at: latest.generated_at, latest, runs: [] }),
      latest.generated_at,
    )
    db.prepare('INSERT INTO system_kv (key,value,updated_at) VALUES (?,?,?)').run(
      'web_parity_gap_queue',
      JSON.stringify({
        updated_at: latest.generated_at,
        candidates: [
          { source: 'web_parity_benchmark', status: 'candidate', url: 'https://pending.example' },
          { source: 'web_parity_benchmark', status: 'gated_out', url: 'https://closed.example' },
          { source: 'web_parity_benchmark', status: 'not_evaluated:extraction_failed', url: 'https://unread.example' },
        ],
      }),
      latest.generated_at,
    )

    const response = await request(makeApp(db)).get('/api/admin/web-parity/status')
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toMatchObject({
      ok: true,
      latest: { generated_at: latest.generated_at, fleet_parity: 88.5 },
      queue: { total: 3, pending_web_parity: 2, pending_breakdown: { candidate: 1, not_evaluated: 1 } },
    })
    db.close()
  })

  it('rejects non-admin callers', async () => {
    const db = makeDb()
    const response = await request(makeApp(db, { admin: false })).get('/api/admin/web-parity/status')
    expect(response.status).toBe(403)
    expect(response.body.error).toBe('admin_required')
    db.close()
  })

  it('atomically deduplicates two immediate in-process launch attempts', async () => {
    const logger = { error() {} }
    const first = launchParityRun({ db: null, logger })
    const second = launchParityRun({ db: null, logger })
    expect(first.already_running).toBe(false)
    expect(second).toEqual({ already_running: true, run_id: first.run_id })
    await first.promise
  })

  it('records a cross-instance scheduler-lock collision as skipped, not successful', async () => {
    const db = makeDb()
    await ensureSchema(db)
    const now = new Date()
    db.prepare(`
      INSERT INTO agent_control_locks
        (id, lock_name, control_run_id, owner_token, acquired_by, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'held-parity-lock',
      'scheduler:web-parity-benchmark',
      'other-instance-run',
      'other-owner-token',
      'other-instance',
      now.toISOString(),
      new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    )

    const launch = launchParityRun({ db, logger: { info() {}, error() {} } })
    await launch.promise
    expect(snapshotState()).toMatchObject({
      running: false,
      run_id: launch.run_id,
      ok: null,
      error: null,
      summary: { ran: false, skipped: true, reason: 'lock_held' },
    })
    db.close()
  })

  it('launches asynchronously and records an honest no-db completion', async () => {
    const launch = launchParityRun({ db: null, logger: { error() {} } })
    expect(launch.already_running).toBe(false)
    expect(launch.run_id).toMatch(/^web-parity-/)
    await launch.promise
    expect(snapshotState()).toMatchObject({
      running: false,
      run_id: launch.run_id,
      ok: false,
      error: 'no_db',
      summary: { ran: false, reason: 'no_db' },
    })
  })
})
