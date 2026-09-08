import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ openai: vi.fn(), anthropic: vi.fn(), construct: vi.fn() }))
vi.mock('openai', () => ({
  default: class {
    constructor(options) {
      sdk.construct(options)
      this.chat = { completions: { create: sdk.openai } }
    }
  },
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: sdk.anthropic }
  },
}))

import { invokeJsonWithFallback, invokeTextWithFallback } from '../utils/aiProviders.js'
import { clearRecentLogs, getRecentLogs } from '../utils/logger.js'

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'fixture-openai-token')
  vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-anthropic-token')
  vi.clearAllMocks()
  clearRecentLogs()
  sdk.openai.mockResolvedValue({ choices: [{ message: { content: '{"answer":"OpenAI"}' } }] })
  sdk.anthropic.mockResolvedValue({ content: [{ text: '{"answer":"Anthropic"}' }] })
})

describe('OpenAI JSON completion recovery', () => {
  const run = (options = {}) => invokeJsonWithFallback({ prompt: 'Read the supplied facts', freeRoutes: [], ...options })
  const completion = (content, finish_reason = 'stop', usage = null) => ({
    choices: [{ finish_reason, message: { content } }], usage,
  })

  it('includes an explicit JSON instruction even when the caller supplies no system message', async () => {
    await run()
    expect(sdk.openai.mock.calls[0][0].messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('Return ONLY a complete, valid JSON object') })
  })

  it('retries a token-truncated response once and accounts for both completions', async () => {
    sdk.openai
      .mockResolvedValueOnce(completion('{"items":[', 'length', { prompt_tokens: 20, completion_tokens: 100, total_tokens: 120 }))
      .mockResolvedValueOnce(completion('{"items":[]}', 'stop', { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }))
    const result = await run({ maxTokens: 100 })
    expect(result).toMatchObject({ ok: true, provider: 'openai', json: { items: [] }, usage: { prompt_tokens: 40, completion_tokens: 105, total_tokens: 145 } })
    expect(sdk.openai.mock.calls.map(([args]) => args.max_tokens)).toEqual([100, 200])
    expect(sdk.anthropic).not.toHaveBeenCalled()
  })

  it('never accepts a response marked truncated, even if its prefix parses', async () => {
    sdk.openai.mockResolvedValue(completion('{"partial":true}', 'length'))
    const result = await run()
    expect(result.provider).toBe('anthropic')
    expect(sdk.openai).toHaveBeenCalledTimes(2)
    const logs = getRecentLogs({ source: 'utils:aiProviders' }).map((entry) => entry.message).join('\n')
    expect(logs).toContain('output_truncated')
    expect(logs).toContain('"finish_reason":"length"')
    expect(logs).not.toContain('"partial":true')
  })

  it.each(['stop', 'content_filter'])('does not retry malformed output with finish reason %s', async (reason) => {
    sdk.openai.mockResolvedValue(completion('private malformed output', reason))
    expect(await run()).toMatchObject({ ok: true, provider: 'anthropic' })
    expect(sdk.openai).toHaveBeenCalledTimes(1)
    const logs = getRecentLogs({ source: 'utils:aiProviders' }).map((entry) => entry.message).join('\n')
    expect(logs).toContain(`"finish_reason":"${reason}"`)
    expect(logs).not.toContain('private malformed output')
  })

  it('does not treat filtered output as a complete answer even if it parses', async () => {
    sdk.openai.mockResolvedValue(completion('{"items":[]}', 'content_filter'))
    expect(await run()).toMatchObject({ ok: true, provider: 'anthropic' })
    expect(sdk.openai).toHaveBeenCalledTimes(1)
  })

  it('caps recovery output and does not retry an already-large request', async () => {
    sdk.openai.mockResolvedValue(completion('{', 'length'))
    await run({ maxTokens: 6000 })
    expect(sdk.openai.mock.calls.map(([args]) => args.max_tokens)).toEqual([6000, 8192])
    sdk.openai.mockClear()
    await run({ maxTokens: 10000 })
    expect(sdk.openai.mock.calls.map(([args]) => args.max_tokens)).toEqual([10000])
  })

  it('does not start recovery when too little deadline remains', async () => {
    sdk.openai.mockResolvedValue(completion('{', 'length'))
    await run({ timeoutMs: 100 })
    expect(sdk.openai).toHaveBeenCalledTimes(1)
  })

  it('keeps a hanging recovery attempt inside the original shared deadline', async () => {
    vi.useFakeTimers()
    sdk.openai
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return completion('{', 'length')
      })
      .mockImplementationOnce(() => new Promise(() => {}))
    const pending = run({ timeoutMs: 2000 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ ok: false, timedOut: true })
    expect(sdk.openai).toHaveBeenCalledTimes(2)
    expect(sdk.anthropic).not.toHaveBeenCalled()
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe.each([
  ['JSON', invokeJsonWithFallback],
  ['text', invokeTextWithFallback],
])('%s provider routing', (format, invoke) => {
  const run = (options = {}) => invoke({ prompt: 'Synthetic routing fixture', freeRoutes: [], ...options })

  it('automatically uses the configured OpenAI key when the caller omits its client', async () => {
    const result = await run()
    expect(result).toMatchObject({ ok: true, provider: 'openai' })
    expect(sdk.construct).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'fixture-openai-token' }))
    expect(sdk.openai).toHaveBeenCalledTimes(1)
    expect(sdk.anthropic).not.toHaveBeenCalled()
  })

  it('preserves an explicitly supplied client', async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: '{"answer":"injected"}' } }] })
    const result = await run({ openai: { chat: { completions: { create } } } })
    expect(result).toMatchObject({ ok: true, provider: 'openai' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(sdk.construct).not.toHaveBeenCalled()
  })

  it('preserves explicit null as an intentional OpenAI opt-out', async () => {
    expect(await run({ openai: null })).toMatchObject({ ok: true, provider: 'anthropic' })
    expect(sdk.construct).not.toHaveBeenCalled()
    expect(sdk.openai).not.toHaveBeenCalled()
  })

  it('uses Anthropic when the OpenAI key is absent', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(await run()).toMatchObject({ ok: true, provider: 'anthropic' })
    expect(sdk.openai).not.toHaveBeenCalled()
  })

  it('falls through an OpenAI quota failure and logs safe diagnostic fields', async () => {
    sdk.openai.mockRejectedValue(Object.assign(new Error('insufficient_quota private-provider-detail'), { status: 429 }))
    expect(await run()).toMatchObject({ ok: true, provider: 'anthropic', openaiError: { status: 429 } })
    const logs = getRecentLogs({ source: 'utils:aiProviders' }).map((entry) => entry.message).join('\n')
    expect(logs).toContain(`OpenAI ${format} call failed`)
    expect(logs).toContain('credit_or_quota_exhausted')
    expect(logs).not.toContain('private-provider-detail')
    expect(logs).not.toContain('fixture-openai-token')
  })

  it('reports both attempted providers failing without inventing a successful result', async () => {
    sdk.openai.mockRejectedValue(Object.assign(new Error('incorrect api key private-openai-detail'), { status: 401 }))
    sdk.anthropic.mockRejectedValue(Object.assign(new Error('Your credit balance is too low private-anthropic-detail'), { status: 400 }))
    expect(await run()).toMatchObject({ ok: false, provider: 'fallback', openaiError: { status: 401 } })
    const logs = getRecentLogs({ source: 'utils:aiProviders' }).map((entry) => entry.message).join('\n')
    expect(logs).toContain('authentication_failed')
    expect(logs).toContain('credit_or_quota_exhausted')
    expect(logs).toContain('"openai_attempted":true')
    expect(logs).not.toContain('private-openai-detail')
    expect(logs).not.toContain('private-anthropic-detail')
  })

  it('distinguishes an unavailable OpenAI client from an attempted failure', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    sdk.anthropic.mockRejectedValue(Object.assign(new Error('credit balance is too low'), { status: 400 }))
    expect(await run()).toMatchObject({ ok: false, openaiError: null })
    const logs = getRecentLogs({ source: 'utils:aiProviders' }).map((entry) => entry.message).join('\n')
    expect(logs).toContain('"openai_available":false')
    expect(logs).toContain('"openai_attempted":false')
  })

  it('retains the shared deadline when the automatically created client hangs', async () => {
    vi.useFakeTimers()
    sdk.openai.mockImplementation(() => new Promise(() => {}))
    const pending = run({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ ok: false, timedOut: true })
    expect(sdk.anthropic).not.toHaveBeenCalled()
    expect(getRecentLogs({ source: 'utils:aiProviders' }).map((entry) => entry.message).join('\n')).toContain('timed_out')
  })
})
