/**
 * Portal-sync routes must outlive the GLOBAL 30s request timeout.
 *
 * THE INCIDENT (2026-08-01): the first live studentaid.gov sync completed
 * server-side in 36 seconds — it signed in, read the portal, wrote to the
 * profile, and recorded a `completed` row in portal_sync_runs — but the caller
 * received a 504 "The server took too long to respond" from the global
 * request/response timeout in backend/server.js.
 *
 * A sync that WORKS but REPORTS FAILURE is worse than one that fails: the user
 * retries it, and learns to doubt data that was actually correct.
 *
 * A portal sync launches a real browser, navigates several authenticated pages,
 * and runs a model extraction; 30s is not a realistic budget for that. These
 * routes re-arm their own socket deadline — and must do so BEFORE any await,
 * since the global deadline is already armed by the time the handler runs.
 */
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../services/hamilton/portalSync/index.js', () => ({
  // A sync that takes longer than the global 30s budget would, simulated
  // without actually sleeping: we only assert the deadline the route ARMED.
  runPortalSync: vi.fn(async () => ({ ok: true, direction: 'read', connectorId: 'studentaid', runId: 'r1' })),
  listRuns: vi.fn(async () => []),
  listConnectors: vi.fn(() => []),
  getConnectorForHost: vi.fn(() => ({ id: 'studentaid' })),
}))

vi.mock('../utils/accessControl.js', () => ({
  requireAuthenticatedUser: () => ({ userId: 'u1' }),
  getAccessibleProfileIds: async () => null, // global access
  getAuthUserId: () => 'u1',
}))

const router = (await import('../routes/hamiltonPortalSync.js')).default
const { runPortalSync } = await import('../services/hamilton/portalSync/index.js')

/**
 * Build an app that arms the SAME 30s global deadline server.js does, and
 * records the last timeout each request/response ended up with.
 */
function makeApp(captured) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    // Mirror the global middleware: arm 30s first.
    req.setTimeout = (ms) => { captured.req = ms; return req }
    res.setTimeout = (ms) => { captured.res = ms; return res }
    req.setTimeout(30_000)
    res.setTimeout(30_000)
    req.db = {}
    next()
  })
  app.use('/api/hamilton/portal-sync', router)
  return app
}

describe('portal-sync request deadline', () => {
  it('re-arms a deadline well beyond the global 30s so a real 36s sync is not 504\'d', async () => {
    const captured = {}
    const app = makeApp(captured)

    const res = await request(app)
      .post('/api/hamilton/portal-sync/read')
      .send({ profileId: 'p1', portalHost: 'studentaid.gov' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // The real run that triggered this took 36s; the global budget was 30s.
    expect(captured.req).toBeGreaterThan(30_000)
    expect(captured.res).toBeGreaterThan(30_000)
    expect(captured.req).toBeGreaterThanOrEqual(60_000)
  })

  it('bounds the deadline — a wedged browser must still die, never hold the socket forever', async () => {
    const captured = {}
    const app = makeApp(captured)
    await request(app)
      .post('/api/hamilton/portal-sync/sync')
      .send({ profileId: 'p1', portalHost: 'studentaid.gov' })

    // 0 / Infinity would disable the timeout entirely — explicitly not allowed.
    expect(captured.req).toBeGreaterThan(0)
    expect(Number.isFinite(captured.req)).toBe(true)
  })

  it('applies to every sync direction (read/write/both), not just read', async () => {
    for (const path of ['read', 'write', 'sync']) {
      const captured = {}
      await request(makeApp(captured))
        .post(`/api/hamilton/portal-sync/${path}`)
        .send({ profileId: 'p1', portalHost: 'studentaid.gov' })
      expect(captured.req, `${path} must re-arm its deadline`).toBeGreaterThan(30_000)
    }
  })

  it('fail-closes the legacy one-click submission endpoint without invoking portal automation', async () => {
    const captured = {}
    runPortalSync.mockClear()
    const res = await request(makeApp(captured))
      .post('/api/hamilton/portal-sync/submit-awards')
      .send({ profileId: 'p1', portalHost: 'studentaid.gov' })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      ok: false,
      error: 'reviewed_submission_adapter_required',
      requires_human_submission: true,
    })
    expect(runPortalSync).not.toHaveBeenCalled()
  })
})
