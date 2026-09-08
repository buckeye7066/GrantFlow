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
