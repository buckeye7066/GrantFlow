import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rows: new Map(), lease: null, verify: vi.fn(), errors: vi.fn(),
  failWrites: false, failReads: false, failLeaseReads: false, pending: [], signal: null,
}))
vi.mock('../services/linkVerificationService.js', () => ({ runLinkVerification: state.verify }))
vi.mock('../services/agentControl/agentControlStore.js', () => ({ getLock: async () => state.lease }))
vi.mock('../services/schedulerLock.js', () => ({
  runWithSchedulerLock: async (_db, options, fn) => {
    expect(options.lockName).toBe('link-verification')
    expect(options.heartbeat).toBe(true)
    if (state.lease) return { skipped: true, reason: 'lock_held' }
    const lease = { acquired_by: options.acquiredBy, expires_at: new Date(Date.now() + 300000).toISOString() }
    state.lease = lease
    const controller = new AbortController()
    state.signal = controller
    try { return await fn({ signal: controller.signal }) }
    finally { if (state.lease === lease) state.lease = null }
  },
}))
vi.mock('../utils/logger.js', () => ({ createLogger: () => ({ error: state.errors, warn: vi.fn(), info: vi.fn() }) }))

import { createAdminLinkVerificationRouter, LINK_VERIFICATION_JOB_STATE_KEY } from '../routes/adminLinkVerification.js'

function database() {
  return { dialect: 'postgres', prepare: sql => ({
    get: async key => {
      if (sql.includes('agent_control_locks')) {
        if (state.failLeaseReads) throw new Error('fixture lease read unavailable')
        return state.lease
      }
      if (state.failReads) throw new Error('fixture database read failure')
      return state.rows.has(key) ? { value: state.rows.get(key) } : undefined
    },
    run: async (...args) => {
      if (state.failWrites) throw new Error('fixture private database credential')
      if (sql.trim().startsWith('INSERT INTO system_kv')) {
        state.rows.set(args[0], args[1]); return { changes: 1 }
      }
      if (sql.trim().startsWith('UPDATE system_kv')) {
        const [value, , key, expected] = args
        if (state.rows.get(key) !== expected) return { changes: 0 }
        state.rows.set(key, value); return { changes: 1 }
      }
      throw new Error('unexpected test SQL')
    },
  }) }
}
function application() {
  const app = express(); app.use(express.json())
  app.use((req, _res, next) => { req.db = database(); next() })
  app.use('/verify-links', createAdminLinkVerificationRouter({ ensureAdminRequest: (req, res) => {
    if (req.get('x-test-admin') === 'yes') return true
    res.status(403).json({ error: 'admin_required' }); return false
  } }))
  return app
}

function pendingVerification() {
  const p = new Promise(resolve => state.pending.push(resolve))
  state.verify.mockReturnValueOnce(p)
}
async function status(app) {
  return (await request(app).get('/verify-links/status').set('x-test-admin', 'yes')).body
}
beforeEach(() => {
  state.rows.clear(); state.lease = null; state.failWrites = false; state.failReads = false; state.failLeaseReads = false
  state.verify.mockReset().mockResolvedValue({ checked: 200, ok: 199, broken: 1 })
  state.errors.mockClear(); state.pending = []; state.signal = null
})
afterEach(async () => {
  for (const resolve of state.pending) resolve({ checked: 0 })
  await new Promise(resolve => setImmediate(resolve))
})

describe('admin link-verification job', () => {
  it('requires authorization on both launch and status', async () => {
    const app = application()
    expect((await request(app).post('/verify-links').send({})).status).toBe(403)
    expect((await request(app).get('/verify-links/status')).status).toBe(403)
    expect(state.verify).not.toHaveBeenCalled()
    expect(state.rows.size).toBe(0)
  })
  it.each([0, 11, 1.5, '2', null])('rejects invalid max_batches %s', async max_batches => {
    const r = await request(application()).post('/verify-links').set('x-test-admin', 'yes').send({ max_batches })
    expect(r.status).toBe(400); expect(state.verify).not.toHaveBeenCalled()
  })
  it('returns 202 while the real worker remains pending, then records completion', async () => {
    const app = application(); pendingVerification()
    const r = await request(app).post('/verify-links').set('x-test-admin', 'yes').send({}).timeout(1500)
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ accepted: true, status_url: '/api/admin/verify-links/status' })
    expect((await status(app)).run).toMatchObject({ run_id: r.body.run_id, status: 'running', batches_completed: 0 })
    state.pending.shift()({ checked: 200, ok: 200 })
    await vi.waitFor(async () => expect((await status(app)).run.status).toBe('completed'))
    expect((await status(app)).run).toMatchObject({ batches_completed: 1, stats: { checked: 200, ok: 200 } })
  })
  it('refuses a second launch without duplicating or replacing the active run', async () => {
    const app = application(); pendingVerification()
    const first = await request(app).post('/verify-links').set('x-test-admin', 'yes').send({})
    const second = await request(app).post('/verify-links').set('x-test-admin', 'yes').send({})
    expect(first.status).toBe(202); expect(second.status).toBe(409)
    expect(state.verify).toHaveBeenCalledTimes(1)
    expect((await status(app)).run.run_id).toBe(first.body.run_id)
  })
  it('does not start when the scheduled verifier holds the shared lease', async () => {
    state.lease = { acquired_by: 'scheduler', expires_at: new Date(Date.now() + 300000).toISOString() }
    const r = await request(application()).post('/verify-links').set('x-test-admin', 'yes').send({})
    expect(r.status).toBe(409); expect(state.verify).not.toHaveBeenCalled(); expect(state.rows.size).toBe(0)
  })
  it('requires durable running-state storage before acknowledging or probing', async () => {
    state.failWrites = true
    const r = await request(application()).post('/verify-links').set('x-test-admin', 'yes').send({})
    expect(r.status).toBe(503); expect(state.verify).not.toHaveBeenCalled()
    expect(JSON.stringify(r.body)).not.toContain('fixture private')
  })
  it('records sanitized failures instead of reporting successful completion', async () => {
    state.verify.mockRejectedValueOnce(new Error('bearer fixture-private-key https://private.example.test'))
    const app = application()
    expect((await request(app).post('/verify-links').set('x-test-admin', 'yes').send({})).status).toBe(202)
    await vi.waitFor(async () => expect((await status(app)).run.status).toBe('failed'))
    const result = await status(app)
    expect(result.run.error).toBe('link_verification_failed')
    expect(JSON.stringify([result, state.errors.mock.calls])).not.toContain('fixture-private-key')
    expect(JSON.stringify([result, state.errors.mock.calls])).not.toContain('private.example.test')
  })
  it('reports a restart-lost lease as interrupted, not completed or forever running', async () => {
    state.rows.set(LINK_VERIFICATION_JOB_STATE_KEY, JSON.stringify({ run_id: 'link-verify-fixture', status: 'running', stats: { checked: 200 } }))
    const result = await status(application())
    expect(result.run).toMatchObject({ status: 'interrupted', error: 'worker_lease_unavailable' })
    expect(result.active).toBe(false)
  })
  it('bounds repeated batches, sums real results, and stops on an empty selection', async () => {
    state.verify.mockResolvedValueOnce({ checked: 200, ok: 200 }).mockResolvedValueOnce({ checked: 0 })
    const app = application()
    await request(app).post('/verify-links').set('x-test-admin', 'yes').send({ max_batches: 10 })
    await vi.waitFor(async () => expect((await status(app)).run.status).toBe('completed'))
    expect(state.verify).toHaveBeenCalledTimes(2)
    expect((await status(app)).run.stats).toMatchObject({ checked: 200, ok: 200 })
    expect(state.verify.mock.calls[0][1]).toMatchObject({ limit: 200, signal: expect.any(AbortSignal) })
  })
  it('does not persist arbitrary worker payloads as public job statistics', async () => {
    state.verify.mockResolvedValueOnce({ checked: 1, ok: 1, private_payload: 'fixture-do-not-expose' })
    const app = application(); await request(app).post('/verify-links').set('x-test-admin', 'yes').send({})
    await vi.waitFor(async () => expect((await status(app)).run.status).toBe('completed'))
    expect(JSON.stringify(await status(app))).not.toContain('fixture-do-not-expose')
  })
  it('stops before the next batch after losing the lease', async () => {
    state.verify.mockImplementationOnce(async () => { state.signal.abort(); return { checked: 200, ok: 200 } })
    const app = application(); await request(app).post('/verify-links').set('x-test-admin', 'yes').send({ max_batches: 3 })
    await vi.waitFor(async () => expect((await status(app)).run.status).toBe('interrupted'))
    expect(state.verify).toHaveBeenCalledTimes(1)
  })
  it('never overwrites a newer run while settling an older failed worker', async () => {
    const newer = { run_id: 'link-verify-newer', status: 'completed', stats: { checked: 7 } }
    state.verify.mockImplementationOnce(async () => {
      state.rows.set(LINK_VERIFICATION_JOB_STATE_KEY, JSON.stringify(newer))
      throw new Error('late old failure')
    })
    const app = application(); await request(app).post('/verify-links').set('x-test-admin', 'yes').send({})
    await vi.waitFor(() => expect(state.lease).toBeNull())
    expect((await status(app)).run).toEqual(newer)
  })
  it('returns a non-cacheable idle status and fails closed when storage is unreadable', async () => {
    const app = application()
    const idle = await request(app).get('/verify-links/status').set('x-test-admin', 'yes')
    expect(idle.body).toMatchObject({ ok: true, run: null, active: false })
    expect(idle.headers['cache-control']).toBe('no-store')
    state.failReads = true
    expect((await request(app).get('/verify-links/status').set('x-test-admin', 'yes')).status).toBe(503)
  })
})

describe('review regression: complete job status', () => {
  it('retains suspicious verdicts so checked equals the sum of verdict categories', async () => {
    state.verify.mockResolvedValueOnce({ checked: 3, ok: 1, suspicious: 2, quarantined: 2 })
    const app = application()
    await request(app).post('/verify-links').set('x-test-admin', 'yes').send({})
    await vi.waitFor(async () => expect((await status(app)).run.status).toBe('completed'))
    expect((await status(app)).run.stats).toMatchObject({ checked: 3, ok: 1, suspicious: 2, quarantined: 2 })
  })
  it('returns 503 rather than a fabricated interrupted state when lease storage fails', async () => {
    const app = application(); pendingVerification()
    await request(app).post('/verify-links').set('x-test-admin', 'yes').send({})
    state.failLeaseReads = true
    const response = await request(app).get('/verify-links/status').set('x-test-admin', 'yes')
    expect(response.status).toBe(503)
    expect(response.body.error).toBe('link_verification_status_unavailable')
    expect(JSON.parse(state.rows.get(LINK_VERIFICATION_JOB_STATE_KEY)).status).toBe('running')
  })
})
