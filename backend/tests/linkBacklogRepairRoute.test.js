/**
 * POST /api/link-backlog-repair/run — when the admin omits cycle_id, the route
 * must mint a genuinely DISTINCT verified_by value per run.
 *
 * linkBacklogRepairService's quorum logic (scheduleRetryableBrokenRows) counts
 * COUNT(DISTINCT verified_by) against verification_events to decide whether a
 * row has been repeatedly, genuinely re-verified. Before this fix, an
 * omitted-cycle_id run always wrote `admin-link-repair:${actor}` — a CONSTANT
 * for the same admin across every run — so repeated real verifications by
 * that admin could never accumulate a >=2 distinct-identity quorum.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const repairCalls = []

vi.mock('../services/linkBacklogRepairService.js', () => ({
  brokenDirectSummary: vi.fn(async () => ({})),
  estimateRepairLockTtlMs: vi.fn(() => 1000),
  reclassifyBrokenResources: vi.fn(async () => ({})),
  repairBrokenDirectBatch: vi.fn(async (_db, options) => {
    repairCalls.push(options)
    return { ok: true, selected: 0, claimed: 0 }
  }),
  scheduleRetryableBrokenRows: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../services/schedulerLock.js', () => ({
  runWithSchedulerLock: vi.fn(async (_db, _opts, fn) => fn()),
}))

const linkBacklogRepairRouter = (await import('../routes/linkBacklogRepair.js')).default

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.ctx = { isAdmin: true, email: 'admin@example.com', userId: 'admin-1' }
    req.db = {}
    next()
  })
  app.use('/api/link-backlog-repair', linkBacklogRepairRouter)
  return app
}

beforeEach(() => {
  repairCalls.length = 0
  vi.clearAllMocks()
})

describe('POST /api/link-backlog-repair/run — verified_by identity', () => {
  it('mints a genuinely distinct verified_by on each run when cycle_id is omitted', async () => {
    const app = makeApp()

    const first = await request(app).post('/api/link-backlog-repair/run').send({})
    const second = await request(app).post('/api/link-backlog-repair/run').send({})

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(repairCalls).toHaveLength(2)

    const [firstVerifiedBy, secondVerifiedBy] = repairCalls.map((c) => c.verifiedBy)
    expect(firstVerifiedBy).toBeTruthy()
    expect(secondVerifiedBy).toBeTruthy()
    // The bug: both runs by the same admin wrote the IDENTICAL string, so
    // COUNT(DISTINCT verified_by) could never reach a >=2 quorum.
    expect(firstVerifiedBy).not.toBe(secondVerifiedBy)
    // Still traceable to the admin who triggered it.
    expect(firstVerifiedBy).toMatch(/^admin-link-repair:admin@example\.com:/)
    expect(secondVerifiedBy).toMatch(/^admin-link-repair:admin@example\.com:/)
  })

  it('still uses the deterministic cycle_id identity when one is supplied', async () => {
    const app = makeApp()

    const first = await request(app).post('/api/link-backlog-repair/run').send({ cycle_id: 'nightly-1' })
    const second = await request(app).post('/api/link-backlog-repair/run').send({ cycle_id: 'nightly-1' })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(repairCalls.map((c) => c.verifiedBy)).toEqual([
      'admin-link-repair:nightly-1',
      'admin-link-repair:nightly-1',
    ])
  })
})
