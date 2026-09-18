import fs from 'node:fs'
import { compileFunction } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Execute the actual scheduling function without opening a server or external connections.
function schedulerFixture({ boot, signal, refreshResult = { ok: true, scanned: 2, repaired: 2, truncated: true } } = {}) {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8')
  const start = source.indexOf('  async function scheduleLinkVerification(dbInstance) {')
  const end = source.indexOf('  // Billing cycle', start)
  if (start < 0 || end <= start) throw new Error('Recurring maintenance boundary was not found')
  const body = source.slice(start, end).replace(/\bimport\(/g, 'dependencyImport(')
  const sequence = [], timers = []
  const refresh = vi.fn(async () => { sequence.push('refresh'); return refreshResult })
  const dependencyImport = async path => {
    if (path === './startup/enforceInvariants.js') return { enforceStaleMatchExplainRefresh: refresh }
    if (path === './services/linkBacklogRepairService.js') return { repairBrokenDirectBatch: async () => { sequence.push('repair'); return {} } }
    if (path === './services/pipelineStrictReconciliation.js') return { refreshHamiltonTaskTruthAfterLinkVerification: async () => { sequence.push('truth'); return { status: 'verified' } } }
    throw new Error('Unexpected scheduler dependency: ' + path)
  }
  const logger = { log: vi.fn(), warn: vi.fn() }
  const factory = compileFunction(body + '\nreturn scheduleLinkVerification', ['app', 'runLinkVerification', 'runWithSchedulerLock', 'console', 'setTimeout', 'setInterval', 'dependencyImport'])
  const schedule = factory({ locals: { bootMaintenancePromise: boot } }, async () => { sequence.push('links'); return {} },
    async (_db, _options, callback) => callback({ signal }), logger,
    callback => timers.push(callback), () => {}, dependencyImport)
  return { schedule, sequence, timers, refresh, logger }
}

describe('existing link-verification scheduler resumes stale evidence', () => {
  it('waits for boot and refreshes one bounded batch under the existing lease before task truth', async () => {
    let release
    const boot = new Promise(resolve => { release = resolve })
    const signal = new AbortController().signal
    const { schedule, sequence, timers, refresh } = schedulerFixture({ boot, signal })
    const db = {}
    await schedule(db)
    const pending = timers[0]()
    await Promise.resolve()
    expect(sequence).toEqual([])
    release()
    await pending
    expect(sequence).toEqual(['links', 'repair', 'refresh', 'truth'])
    expect(refresh).toHaveBeenCalledExactlyOnceWith(db, { signal })
  })

  it('logs an explicit failed refresh without suppressing unrelated task-truth maintenance', async () => {
    const { schedule, timers, sequence, logger } = schedulerFixture({ refreshResult: { ok: false, skipped: 'query' } })
    await schedule({})
    await timers[0]()
    expect(sequence).toEqual(['links', 'repair', 'refresh', 'truth'])
    expect(logger.warn).toHaveBeenCalledWith('[stale-match-explain] recurring refresh failed:', expect.objectContaining({ ok: false, skipped: 'query' }))
  })

  it('does not start the refresh after the scheduler lease has been cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('lease cancelled'))
    const { schedule, timers, refresh } = schedulerFixture({ signal: controller.signal })
    await schedule({})
    await timers[0]()
    expect(refresh).not.toHaveBeenCalled()
  })
})
