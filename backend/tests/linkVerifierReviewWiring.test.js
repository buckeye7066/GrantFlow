import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { checkUrl } from '../services/linkVerificationService.js'

// Exercise the actual safeFetch signal path without opening a network socket.
describe('active verification probe cancellation', () => {
  it.each(['HEAD', 'GET'])('aborts an active %s probe and does not retry after cancellation', async method => {
    const controller = new AbortController()
    let probeSignal; let releaseProbe; let entered
    const started = new Promise(resolve => { entered = resolve })
    const fetchImpl = vi.fn(async (_url, init) => {
      if (method === 'GET' && init.method === 'HEAD') return { status: 405, url: 'https://8.8.8.8/fixture' }
      if (!probeSignal) {
        probeSignal = init.signal
        entered()
        return new Promise((_resolve, reject) => {
          releaseProbe = () => reject(controller.signal.reason)
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        })
      }
      return { status: 200, url: 'https://8.8.8.8/fixture' }
    })
    const pending = checkUrl('https://8.8.8.8/fixture', { fetchImpl, signal: controller.signal })
      .then(() => ({ kind: 'resolved' }), error => ({ kind: 'rejected', name: error.name }))
    await started
    controller.abort(new DOMException('fixture cancelled', 'AbortError'))
    const abortedImmediately = probeSignal.aborted
    releaseProbe()
    const result = await pending
    expect(abortedImmediately).toBe(true)
    expect(result).toEqual({ kind: 'rejected', name: 'AbortError' })
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(method === 'HEAD' ? ['HEAD'] : ['HEAD', 'GET'])
  })
})

describe('cloud verifier shared-lease wiring', () => {
  it('uses the same renewed lease and a live instance heartbeat before cloud batches', () => {
    const source = readFileSync(new URL('../../tools/weekly-link-verify.mjs', import.meta.url), 'utf8')
    expect(source).toContain("lockName: 'link-verification'")
    expect(source).toContain('heartbeat: true')
    expect(source).toContain('startInstanceHeartbeat(db)')
    expect(source).toContain('stopInstanceHeartbeat()')
    expect(source).toMatch(/runWithSchedulerLock\(db,[\s\S]*?signal: lease.signal/)
    expect(source).toContain('if (s?.skipped)')
    expect(source).toMatch(/finally\s*\{[\s\S]*stopInstanceHeartbeat\(\)[\s\S]*pool.end\(\)/)
  })
})
