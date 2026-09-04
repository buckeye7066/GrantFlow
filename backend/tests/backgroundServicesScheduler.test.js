import { afterEach, describe, expect, it, vi } from 'vitest'

import { readFileSync } from 'node:fs'

import { startGuardedBackgroundInterval } from '../startup/guardedBackgroundInterval.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startGuardedBackgroundInterval', () => {
  it('guards the Anya schedule interval in the live server startup path', () => {
    const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8')

    expect(serverSource).toMatch(/startGuardedBackgroundInterval\(\{\s*name: 'anya-scheduled-check'/)
    expect(serverSource).not.toMatch(/setInterval\(\(\) => \{\s*import\('\.\/services\/anyaAutonomousScheduler\.js'\)/)
  })

  it('skips a tick while the previous async run is still in flight', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const task = vi.fn(async () => gate)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const scheduler = startGuardedBackgroundInterval({
      name: 'test-overlap',
      intervalMs: 60_000,
      task,
    })

    const first = scheduler.tick()
    const second = await scheduler.tick()

    expect(second).toEqual({ skipped: true, reason: 'already_running' })
    expect(task).toHaveBeenCalledTimes(1)

    release()
    await expect(first).resolves.toMatchObject({ skipped: false, ok: true })
    clearInterval(scheduler.handle)
  })

  it('consumes task rejection so the interval cannot create an unhandled rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const task = vi.fn(async () => {
      throw new Error('expected scheduler failure')
    })

    const scheduler = startGuardedBackgroundInterval({
      name: 'test-rejection',
      intervalMs: 60_000,
      task,
    })

    const result = await scheduler.tick()
    expect(result.skipped).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.error).toBeInstanceOf(Error)
    expect(task).toHaveBeenCalledTimes(1)
    clearInterval(scheduler.handle)
  })

  it('rejects invalid scheduler configuration immediately', () => {
    expect(() => startGuardedBackgroundInterval({
      name: 'bad-interval',
      intervalMs: 0,
      task: async () => {},
    })).toThrow(/positive intervalMs/)

    expect(() => startGuardedBackgroundInterval({
      name: 'bad-task',
      intervalMs: 1000,
      task: null,
    })).toThrow(/task function/)
  })
})
