// Guards the 2026-07-20 fix: POST /api/anya/autonomous/crawlers used to
// `await` runAutonomousCrawlers() synchronously inside the HTTP handler.
// runAutonomousCrawlers now drives the Crawler OS one real profile at a time
// (fetch + reality-gate + match per source, no batching), which at current
// profile counts routinely exceeds the platform proxy timeout — the owner
// hit a live 504 on this exact route. The fix mirrors the sibling
// /autonomous/code/background route's already-established fire-and-forget
// pattern (startBackgroundCodeCrawlAndRepair / getBackgroundCodeCrawlState).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runAutonomousCrawlers = vi.fn()
vi.mock('../services/anyaAutonomousFunctionRunner.js', () => ({ runAutonomousCrawlers }))

const {
  startBackgroundCrawlerRun,
  getBackgroundCrawlerRunState,
} = await import('../services/anyaAutonomousScheduler.js')

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('startBackgroundCrawlerRun (fire-and-forget)', () => {
  beforeEach(() => {
    runAutonomousCrawlers.mockReset()
  })

  it('returns { queued: true } IMMEDIATELY without awaiting the crawler run', async () => {
    let resolveRun
    runAutonomousCrawlers.mockReturnValue(new Promise((resolve) => { resolveRun = resolve }))

    const result = startBackgroundCrawlerRun({}, { db: {}, user: { id: 'admin-1' } })
    // Synchronous return — proves the route handler can respond 202 right away
    // instead of blocking on the crawl (the exact shape of the 504).
    expect(result.queued).toBe(true)
    expect(getBackgroundCrawlerRunState().running).toBe(true)

    resolveRun({ profiles_processed: 1, jobs_completed: 1, opportunities_stored: 3 })
    await flush()
    const state = getBackgroundCrawlerRunState()
    expect(state.running).toBe(false)
    expect(state.lastResult).toEqual({ profiles_processed: 1, jobs_completed: 1, opportunities_stored: 3 })
    expect(state.lastError).toBeNull()
  })

  it('refuses to start a second run while one is already in progress', async () => {
    let resolveRun
    runAutonomousCrawlers.mockReturnValue(new Promise((resolve) => { resolveRun = resolve }))

    const first = startBackgroundCrawlerRun({}, { db: {}, user: { id: 'admin-1' } })
    expect(first.queued).toBe(true)

    const second = startBackgroundCrawlerRun({}, { db: {}, user: { id: 'admin-1' } })
    expect(second.queued).toBe(false)
    expect(runAutonomousCrawlers).toHaveBeenCalledTimes(1)

    resolveRun({ profiles_processed: 0 })
    await flush()
  })

  it('records lastError (not a thrown exception) when the crawl fails', async () => {
    runAutonomousCrawlers.mockRejectedValue(new Error('boom'))

    const result = startBackgroundCrawlerRun({}, { db: {}, user: { id: 'admin-1' } })
    expect(result.queued).toBe(true)
    await flush()
    await flush()

    const state = getBackgroundCrawlerRunState()
    expect(state.running).toBe(false)
    expect(state.lastError).toBe('boom')
  })
})
