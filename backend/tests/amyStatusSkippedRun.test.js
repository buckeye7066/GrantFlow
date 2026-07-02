/**
 * GET /api/amy/status must expose the last run's SUMMARY so a run deduped by
 * the scheduler lock (state.ok=true, summary={skipped:true, reason:'lock_held'})
 * is distinguishable from a real training run — previously both looked like
 * last_run_ok:true and admins/panels could not tell them apart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../services/amy/amyReportStore.js', () => ({
  readLatestAmyReport: vi.fn(async () => null),
  readAmyHistory: vi.fn(async () => []),
  readAmyApprovalQueue: vi.fn(async () => ({ queue: [] })),
}))
vi.mock('../services/amy/amyScheduler.js', () => ({
  getAmyConfig: vi.fn(() => ({ enabled: true, runOnSchedule: false, dailyTarget: 12 })),
}))
vi.mock('../services/amy/amyRunner.js', () => ({
  launchAmyRun: vi.fn(),
  getAmyRunState: vi.fn(),
}))

import amyRouter from '../routes/amy.js'
import { getAmyRunState } from '../services/amy/amyRunner.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.ctx = { isAdmin: true, email: 'admin@example.com', userId: 'u1' }
    req.db = {}
    next()
  })
  app.use('/api/amy', amyRouter)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/amy/status skipped-run honesty', () => {
  it('exposes a lock-deduped run as skipped (summary + skip reason)', async () => {
    getAmyRunState.mockReturnValue({
      running: false,
      run_id: 'run-1',
      source: 'admin',
      started_at: '2026-07-02T05:00:00.000Z',
      finished_at: '2026-07-02T05:00:01.000Z',
      ok: true,
      error: null,
      summary: { skipped: true, reason: 'lock_held' },
    })
    const res = await request(makeApp()).get('/api/amy/status')
    expect(res.status).toBe(200)
    expect(res.body.status.last_run_ok).toBe(true)
    expect(res.body.status.last_run_skipped).toBe(true)
    expect(res.body.status.last_run_skip_reason).toBe('lock_held')
    expect(res.body.status.last_run_summary).toEqual({ skipped: true, reason: 'lock_held' })
    expect(res.body.status.last_run_finished_at).toBe('2026-07-02T05:00:01.000Z')
  })

  it('reports a real training run as not skipped, with its summary', async () => {
    getAmyRunState.mockReturnValue({
      running: false,
      run_id: 'run-2',
      source: 'scheduler',
      started_at: '2026-07-02T05:00:00.000Z',
      finished_at: '2026-07-02T05:20:00.000Z',
      ok: true,
      error: null,
      summary: { profiles: 12, crawled: 12 },
    })
    const res = await request(makeApp()).get('/api/amy/status')
    expect(res.status).toBe(200)
    expect(res.body.status.last_run_skipped).toBe(false)
    expect(res.body.status.last_run_skip_reason).toBe(null)
    expect(res.body.status.last_run_summary).toEqual({ profiles: 12, crawled: 12 })
  })

  it('tolerates a null summary (no run yet)', async () => {
    getAmyRunState.mockReturnValue({
      running: false, run_id: null, source: null, started_at: null,
      finished_at: null, ok: null, error: null, summary: null,
    })
    const res = await request(makeApp()).get('/api/amy/status')
    expect(res.status).toBe(200)
    expect(res.body.status.last_run_summary).toBe(null)
    expect(res.body.status.last_run_skipped).toBe(false)
  })
})
