/**
 * gracefulShutdown — a deploy-swap SIGTERM must exit ZERO, fast, even with idle
 * keep-alive sockets lingering (keepAliveTimeout is 620s). A non-zero exit here
 * is what made Railway email "Deploy Crashed" on every deploy.
 */
import { describe, it, expect, vi } from 'vitest'
import { runGracefulShutdown } from '../startup/gracefulShutdown.js'

function fakeServer({ closeCallsBack = true } = {}) {
  return {
    closeIdle: 0,
    closeAll: 0,
    closeIdleConnections() { this.closeIdle += 1 },
    closeAllConnections() { this.closeAll += 1 },
    close(cb) { if (closeCallsBack) setImmediate(cb) }, // never calls back if a socket lingers
  }
}
const silent = { error() {}, warn() {}, log() {} }

describe('runGracefulShutdown', () => {
  it('releases idle keep-alive sockets immediately (so close() is not held 620s)', async () => {
    const server = fakeServer()
    const exit = vi.fn()
    runGracefulShutdown({ server, closeDb: () => {}, flush: () => {}, exit, log: silent })
    expect(server.closeIdle).toBe(1)
    await new Promise((r) => setImmediate(r))
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('closes the DB and flushes before exiting on a clean close', async () => {
    const order = []
    const server = fakeServer()
    const exit = vi.fn(() => order.push('exit'))
    runGracefulShutdown({
      server,
      closeDb: async () => { order.push('db') },
      flush: async () => { order.push('flush') },
      exit, log: silent,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(order).toEqual(['db', 'flush', 'exit'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('EXITS ZERO on the force-timeout path when close() never drains (the crash fix)', async () => {
    // A lingering idle keep-alive means close()'s callback never fires. The old
    // code exited 1 here → "Deploy Crashed". It must now force-close and exit 0.
    const server = fakeServer({ closeCallsBack: false })
    const exit = vi.fn()
    runGracefulShutdown({ server, closeDb: () => {}, flush: () => {}, exit, log: silent, graceMs: 10 })
    await new Promise((r) => setTimeout(r, 30))
    expect(server.closeAll).toBe(1)
    expect(exit).toHaveBeenCalledWith(0)
    expect(exit).not.toHaveBeenCalledWith(1)
  })

  it('exits only ONCE even if close() and the timeout both fire', async () => {
    const server = fakeServer({ closeCallsBack: true })
    const exit = vi.fn()
    runGracefulShutdown({ server, closeDb: () => {}, flush: () => {}, exit, log: silent, graceMs: 5 })
    await new Promise((r) => setTimeout(r, 30))
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('still exits (0) when the DB close throws — a broken teardown must not hang the process', async () => {
    const server = fakeServer()
    const exit = vi.fn()
    runGracefulShutdown({ server, closeDb: () => { throw new Error('db boom') }, flush: () => {}, exit, log: silent })
    await new Promise((r) => setTimeout(r, 5))
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('tolerates a runtime without closeIdleConnections/closeAllConnections (older Node)', async () => {
    const server = { close(cb) { setImmediate(cb) } } // no closeIdle/closeAll methods
    const exit = vi.fn()
    expect(() => runGracefulShutdown({ server, closeDb: () => {}, flush: () => {}, exit, log: silent })).not.toThrow()
    await new Promise((r) => setImmediate(r))
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits 0 immediately when there is no server', () => {
    const exit = vi.fn()
    runGracefulShutdown({ server: null, exit, log: silent })
    expect(exit).toHaveBeenCalledWith(0)
  })
})
