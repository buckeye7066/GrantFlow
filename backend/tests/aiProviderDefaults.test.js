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
import { extractOpportunitiesFromPage } from '../services/webGrantExtractor.js'
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

  it('reserves Anthropic time when truncation recovery hangs, inside the original shared deadline', async () => {
    vi.useFakeTimers()
    sdk.openai
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return completion('{', 'length')
      })
      .mockImplementationOnce(() => new Promise(() => {}))
    const pending = run({ timeoutMs: 6000 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toMatchObject({ ok: true, provider: 'anthropic' })
    expect(sdk.openai).toHaveBeenCalledTimes(2)
    expect(sdk.anthropic).toHaveBeenCalledTimes(1)
    expect(sdk.openai.mock.calls[1][1].signal.aborted).toBe(true)
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

  it('aborts the active request and starts no later provider after caller cancellation', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    sdk.openai.mockImplementation(() => new Promise(() => {}))
    const freeClientFactory = vi.fn()
    const pending = run({ signal: controller.signal, timeoutMs: 10000, freeRoutes: [{ id: 'free', base_url: 'http://fixture.invalid/v1', model: 'fixture' }], freeClientFactory })
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending).toMatchObject({ ok: false, aborted: true })
    expect(sdk.openai.mock.calls[0][1].signal.aborted).toBe(true)
    expect(sdk.anthropic).not.toHaveBeenCalled()
    expect(freeClientFactory).not.toHaveBeenCalled()
  })

  it('preserves the free reserve and total deadline when both paid providers hang', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    sdk.openai.mockImplementation(() => new Promise(() => {}))
    sdk.anthropic.mockImplementation(() => new Promise(() => {}))
    const freeCreate = vi.fn(() => new Promise(() => {}))
    const factory = vi.fn(async () => ({ chat: { completions: { create: freeCreate } } }))
    const pending = run({ timeoutMs: 20000, freeRoutes: [{ id: 'free', base_url: 'http://fixture.invalid/v1', model: 'fixture' }], freeClientFactory: factory })
    await vi.advanceTimersByTimeAsync(13999)
    expect(factory).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6000)
    expect(await pending).toMatchObject({ ok: false, timedOut: true })
    expect(Date.now() - start).toBe(20000)
    expect(freeCreate.mock.calls[0][1].signal.aborted).toBe(true)
  })
  it('does not start a free provider when the caller aborts during Anthropic', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    sdk.openai.mockRejectedValue(new Error('fixture primary failure'))
    sdk.anthropic.mockImplementation(() => new Promise(() => {}))
    const factory = vi.fn()
    const pending = run({ signal: controller.signal, timeoutMs: 20000, freeRoutes: [{ id: 'free', base_url: 'http://fixture.invalid/v1', model: 'fixture' }], freeClientFactory: factory })
    await vi.advanceTimersByTimeAsync(1)
    expect(sdk.anthropic).toHaveBeenCalledTimes(1)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending).toMatchObject({ ok: false, aborted: true })
    expect(sdk.anthropic.mock.calls[0][1].signal.aborted).toBe(true)
    expect(factory).not.toHaveBeenCalled()
  })

  it.each([0, -1])('does not reset an exhausted caller budget of %s ms', async timeoutMs => {
    const factory = vi.fn()
    const result = await run({ timeoutMs, freeRoutes: [{ id: 'free', base_url: 'http://fixture.invalid/v1', model: 'fixture' }], freeClientFactory: factory })
    expect(result.ok).toBe(false)
    expect(sdk.openai).not.toHaveBeenCalled()
    expect(sdk.anthropic).not.toHaveBeenCalled()
    expect(factory).not.toHaveBeenCalled()
  })

  it('does not reserve time for an absent Anthropic provider', async () => {
    vi.useFakeTimers()
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    sdk.openai.mockImplementation(() => new Promise(() => {}))
    let settled = false
    const pending = run({ timeoutMs: 1000 }).then(value => { settled = true; return value })
    await vi.advanceTimersByTimeAsync(600)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(400)
    expect(await pending).toMatchObject({ ok: false, timedOut: true })
    expect(sdk.anthropic).not.toHaveBeenCalled()
  })

  it('makes no provider request for a pre-aborted caller', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await run({ signal: controller.signal })).toMatchObject({ ok: false, aborted: true })
    expect(sdk.openai).not.toHaveBeenCalled()
    expect(sdk.anthropic).not.toHaveBeenCalled()
  })

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
    sdk.anthropic.mockImplementation(() => new Promise(() => {}))
    const pending = run({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ ok: false, timedOut: true })
    expect(sdk.anthropic).toHaveBeenCalledTimes(1)
    expect(sdk.anthropic.mock.calls[0][1].signal.aborted).toBe(true)
    expect(getRecentLogs({ source: 'utils:aiProviders' }).map((entry) => entry.message).join('\n')).toContain('timed_out')
  })
})


describe('live extraction provider deadline', () => {
  it('uses Anthropic recovery before the page deadline after OpenAI truncates then hangs', async () => {
    vi.useFakeTimers()
    sdk.openai.mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }).mockImplementationOnce(() => new Promise(() => {}))
    sdk.anthropic.mockResolvedValue({ content: [{ text: JSON.stringify({ opportunities: [{ title: 'Nashville Youth Fund Grant', funder: 'Nashville Youth Fund', summary: 'A youth grant.', eligibility_bullets: [], states: [], need_categories: [], evidence: {} }] }) }] })
    const html = '<main><h1>Nashville Youth Fund Grant</h1><p>The Nashville Youth Fund offers grants to nonprofit organizations serving youth in Tennessee. Applications are due September 1, 2026. Awards are up to $10,000. Applicants may submit one proposal during the current funding cycle.</p></main>'
    const pending = extractOpportunitiesFromPage({ pageUrl: 'https://fixture.invalid/grant', html }, { timeoutMs: 20000, invoke: opts => invokeJsonWithFallback({ ...opts, freeRoutes: [] }) })
    await vi.advanceTimersByTimeAsync(10001)
    const result = await pending
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Nashville Youth Fund Grant')
    expect(sdk.openai.mock.calls.map(([args]) => args.max_tokens)).toEqual([1800, 3600])
    expect(sdk.anthropic).toHaveBeenCalledTimes(1)
  })
})
