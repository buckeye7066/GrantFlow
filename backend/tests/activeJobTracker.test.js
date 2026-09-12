import { describe, expect, it } from 'vitest'
import {
  clearActiveJob,
  getActiveJobsSnapshot,
  setActiveJob,
  withActiveJob,
} from '../utils/activeJobTracker.js'

describe('activeJobTracker', () => {
  it('reports an empty snapshot when nothing is running', () => {
    expect(getActiveJobsSnapshot()).toEqual([])
  })

  it('tracks a job from set through clear, with a running duration', () => {
    setActiveJob('test:job', '1/10')
    const snap = getActiveJobsSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0].name).toBe('test:job')
    expect(snap[0].detail).toBe('1/10')
    expect(snap[0].running_ms).toBeGreaterThanOrEqual(0)

    clearActiveJob('test:job')
    expect(getActiveJobsSnapshot()).toEqual([])
  })

  it('updates detail in place without resetting the start time', async () => {
    setActiveJob('test:job', '1/10')
    await new Promise((resolve) => setTimeout(resolve, 5))
    setActiveJob('test:job', '2/10')
    const snap = getActiveJobsSnapshot()
    expect(snap[0].detail).toBe('2/10')
    expect(snap[0].running_ms).toBeGreaterThan(0)
    clearActiveJob('test:job')
  })

  it('withActiveJob clears the job even when the wrapped function throws', async () => {
    await expect(
      withActiveJob('test:throws', null, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(getActiveJobsSnapshot()).toEqual([])
  })

  it('withActiveJob returns the wrapped function result and clears on success', async () => {
    const result = await withActiveJob('test:ok', 'detail', async () => 42)
    expect(result).toBe(42)
    expect(getActiveJobsSnapshot()).toEqual([])
  })
})
