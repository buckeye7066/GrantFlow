import { afterEach, describe, expect, it, vi } from 'vitest'

const lockMocks = vi.hoisted(() => ({
  renewLock: vi.fn(),
  withLock: vi.fn(async (_db, _options, fn) => fn({ ownerToken: 'owner-token' })),
}))

vi.mock('../services/agentControl/agentControlStore.js', () => lockMocks)
vi.mock('../utils/observability.js', () => ({ captureException: vi.fn() }))

const { runWithSchedulerLock } = await import('../services/schedulerLock.js')

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('scheduler lock heartbeat', () => {
  it('fails the scheduler result when fenced renewal says the lease was lost', async () => {
    vi.useFakeTimers()
    lockMocks.renewLock.mockResolvedValue(false)
    const run = runWithSchedulerLock(
      { prepare() {} },
      { lockName: 'daily-job', ttlMs: 90_000, heartbeat: true, logger: { error: vi.fn(), warn: vi.fn() } },
      async (lease) => {
        expect(lease.signal).toBeInstanceOf(AbortSignal)
        return new Promise((resolve, reject) => {
          lease.signal.addEventListener('abort', () => reject(lease.signal.reason), { once: true })
        })
      },
    )
    const rejected = expect(run).rejects.toMatchObject({ code: 'LOCK_LEASE_LOST' })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(lockMocks.renewLock).toHaveBeenCalledTimes(1)
    await rejected
  })

  it('still returns the critical-section result when renewal succeeds', async () => {
    vi.useFakeTimers()
    lockMocks.renewLock.mockResolvedValue(true)
    let finish
    const criticalSection = new Promise((resolve) => { finish = resolve })

    const run = runWithSchedulerLock(
      { prepare() {} },
      { lockName: 'daily-job', ttlMs: 90_000, heartbeat: true },
      async () => criticalSection,
    )

    await vi.advanceTimersByTimeAsync(30_000)
    finish('done')
    await expect(run).resolves.toBe('done')
  })
})
