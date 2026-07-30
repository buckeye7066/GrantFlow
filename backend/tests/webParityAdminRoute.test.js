import Database from 'better-sqlite3'
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import router, {
  launchParityRun,
  pendingWebParity,
  snapshotState,
} from '../routes/webParityAdmin.js'

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
      queue: { total: 2, pending_web_parity: 1 },
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
