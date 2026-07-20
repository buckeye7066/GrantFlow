import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/crawlerJobCreation.js', () => ({
  createCrawlerJob: vi.fn(),
}))
vi.mock('../services/crawlerDispatcher.js', () => ({
  dispatchCrawlerJob: vi.fn(async () => ({ ok: true })),
}))

import { invokeTool } from '../services/anyaToolRegistry.js'
import { createCrawlerJob } from '../services/crawlerJobCreation.js'
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js'

function ctx() {
  return { db: {}, ctx: { isAdmin: true, userId: 'admin-1' }, user: { role: 'admin' } }
}

describe('admin.crawler.triggerAll', () => {
  beforeEach(() => {
    createCrawlerJob.mockReset()
    dispatchCrawlerJob.mockClear()
  })

  it('routes every requested type through the createCrawlerJob choke point instead of a raw INSERT', async () => {
    createCrawlerJob.mockImplementation(async (_db, { type }) => ({
      jobId: `job-${type}`,
      created: true,
      existing: false,
    }))

    const { output: result } = await invokeTool(
      'admin.crawler.triggerAll',
      { profileId: 'p1', crawlerTypes: ['profile_enrichment', 'avatar_lookup'] },
      ctx(),
    )

    expect(createCrawlerJob).toHaveBeenCalledTimes(2)
    expect(createCrawlerJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'profile_enrichment',
      profileId: 'p1',
    }))
    expect(createCrawlerJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'avatar_lookup',
      profileId: 'p1',
    }))
    expect(result.jobsCreated).toBe(2)
    expect(result.jobsSkipped).toBe(0)
    expect(result.jobs).toEqual([
      { type: 'profile_enrichment', profileId: 'p1', jobId: 'job-profile_enrichment', existing: false },
      { type: 'avatar_lookup', profileId: 'p1', jobId: 'job-avatar_lookup', existing: false },
    ])
  })

  it('never persists a row for a retired discovery-crawler type — the exact class of bug that created the 6/23 dead-on-arrival batch', async () => {
    // createCrawlerJob's own CUTOVER GUARD is what actually refuses a
    // superseded type; this test proves triggerAll now calls createCrawlerJob
    // at all (previously it bypassed it with `db.prepare('INSERT INTO
    // crawler_jobs ...')`, so the guard was never consulted regardless of
    // what type was requested).
    createCrawlerJob.mockImplementation(async (_db, { type }) => ({
      jobId: null,
      created: false,
      existing: false,
      superseded: true,
      skipped: true,
      job: null,
    }))

    const { output: result } = await invokeTool(
      'admin.crawler.triggerAll',
      { profileId: 'p1', crawlerTypes: ['profile_enrichment'] },
      ctx(),
    )

    expect(createCrawlerJob).toHaveBeenCalledTimes(1)
    expect(result.jobsCreated).toBe(0)
    expect(result.jobsSkipped).toBe(1)
    expect(result.skipped).toEqual([{ type: 'profile_enrichment', reason: 'superseded_by_crawler_os' }])
    expect(dispatchCrawlerJob).not.toHaveBeenCalled()
  })

  it('dispatches newly-created jobs immediately rather than waiting for the next poll cycle', async () => {
    createCrawlerJob.mockResolvedValue({ jobId: 'job-1', created: true, existing: false })

    await invokeTool(
      'admin.crawler.triggerAll',
      { profileId: 'p1', crawlerTypes: ['portal_check'] },
      ctx(),
    )

    // dispatchCrawlerJob is fired via setImmediate — flush the microtask/macrotask queue.
    await new Promise((resolve) => setImmediate(resolve))
    expect(dispatchCrawlerJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }))
  })

  it('does not re-dispatch an already-existing (idempotent-matched) job', async () => {
    createCrawlerJob.mockResolvedValue({ jobId: 'job-existing', created: false, existing: true })

    await invokeTool(
      'admin.crawler.triggerAll',
      { profileId: 'p1', crawlerTypes: ['portal_check'] },
      ctx(),
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(dispatchCrawlerJob).not.toHaveBeenCalled()
  })

  it('defaults to the real, still-running types when crawlerTypes is omitted', async () => {
    createCrawlerJob.mockImplementation(async (_db, { type }) => ({
      jobId: `job-${type}`,
      created: true,
      existing: false,
    }))

    await invokeTool('admin.crawler.triggerAll', { profileId: 'p1' }, ctx())

    const requestedTypes = createCrawlerJob.mock.calls.map(([, opts]) => opts.type)
    expect(requestedTypes).toEqual(['profile_enrichment', 'avatar_lookup', 'portal_check'])
    // None of the retired discovery types should ever be requested by default.
    expect(requestedTypes).not.toContain('local')
    expect(requestedTypes).not.toContain('scholarship')
    expect(requestedTypes).not.toContain('comprehensive')
  })
})
