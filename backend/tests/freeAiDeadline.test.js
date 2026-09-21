import {afterEach, expect, it, vi} from 'vitest'
import {invokeFreeJsonRoutes} from '../utils/freeAiRoutes.js'
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
it.each([['',25000],['4000',4000],['60000',25000]])('aligns the SDK timeout with the allocated deadline (configured %s)', async (configured, expected) => {
  vi.useFakeTimers()
  vi.stubEnv('FREE_AI_TIMEOUT_MS',configured)
  const create = vi.fn(async () => ({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}))
  const result = await invokeFreeJsonRoutes({routes:[{id:'deadline',model:'fixture',baseURL:'https://deadline.example.invalid/v1'}],prompt:'JSON',maxTokens:64,timeoutMs:25000,
    clientFactory:()=>({chat:{completions:{create}}})})
  expect(result.ok).toBe(true)
  expect(create.mock.calls[0][1]).toMatchObject({timeout:expected,maxRetries:0})
})
