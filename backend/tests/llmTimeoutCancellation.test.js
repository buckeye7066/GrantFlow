import { afterEach, it, expect, vi } from 'vitest'
import { withLLMTimeout } from '../utils/llmTimeout.js'
afterEach(() => vi.useRealTimers())
it('aborts the signal given to in-flight work at its attempt deadline', async () => {
  vi.useFakeTimers()
  let activeSignal
  const pending = withLLMTimeout(signal => { activeSignal = signal; return new Promise(() => {}) }, { timeoutMs: 100 })
  const checked = expect(pending).rejects.toMatchObject({ code: 'LLM_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(100)
  await checked
  expect(activeSignal.aborted).toBe(true)
})
it('settles promptly on caller abort and never invokes pre-aborted work', async () => {
  const controller = new AbortController()
  let activeSignal
  const pending = withLLMTimeout(signal => { activeSignal = signal; return new Promise(() => {}) }, { signal: controller.signal })
  const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await Promise.resolve()
  controller.abort()
  await checked
  expect(activeSignal.aborted).toBe(true)
  const work = vi.fn()
  await expect(withLLMTimeout(work, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(work).not.toHaveBeenCalled()
})
