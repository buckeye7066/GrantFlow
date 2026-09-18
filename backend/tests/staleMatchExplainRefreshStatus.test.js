import { beforeEach, describe, expect, it, vi } from 'vitest'
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('../services/matching/staleMatchExplainRefresh.js', () => ({ runStaleMatchExplainRefresh: refresh }))
const { enforceStaleMatchExplainRefresh, projectPersistedStep } = await import('../startup/enforceInvariants.js')
beforeEach(() => refresh.mockReset())

describe('stored-explanation maintenance status', () => {
  it('does not turn a candidate-query failure into a green boot invariant', async () => {
    refresh.mockResolvedValue({ ok: false, skipped: 'query', write_enabled: true, scanned: 0, refreshed: 0 })
    const result = await enforceStaleMatchExplainRefresh({})
    expect(result).toMatchObject({ name: 'stale_match_explain_refresh', ok: false, skipped: 'query' })
    expect(projectPersistedStep(result)).toMatchObject({ ok: false, skipped: 'query' })
  })

  it('retains failed writes and deferred evidence through the persisted boot summary', async () => {
    refresh.mockResolvedValue({ ok: false, write_enabled: true, scanned: 6, refreshed: 1,
      convergence_errors: 2, skipped_no_profile: 1, unscorable: 1, concurrent_changes_skipped: 1, truncated: true })
    expect(projectPersistedStep(await enforceStaleMatchExplainRefresh({}))).toMatchObject({
      ok: false, scanned: 6, repaired: 1, convergenceErrors: 2, skippedNoProfile: 1,
      unscorable: 1, concurrentChangesSkipped: 1, truncated: true,
    })
  })

  it('forwards the existing scheduler cancellation signal and preserves a clean result', async () => {
    refresh.mockResolvedValue({ ok: true, write_enabled: true, scanned: 1, refreshed: 1, truncated: false })
    const db = {}, options = { signal: new AbortController().signal }
    expect(await enforceStaleMatchExplainRefresh(db, options)).toMatchObject({ ok: true, repaired: 1, truncated: false })
    expect(refresh).toHaveBeenCalledWith(db, options)
  })

  it('does not invent optional diagnostics on unrelated invariant results', () => {
    expect(projectPersistedStep({ name: 'unrelated', ok: true, repaired: 0, scanned: 0 }))
      .toEqual({ name: 'unrelated', ok: true, repaired: 0, scanned: 0 })
  })
})
