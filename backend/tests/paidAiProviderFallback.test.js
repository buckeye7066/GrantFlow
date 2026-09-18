import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const sdk = vi.hoisted(() => ({ responses: vi.fn(), openai: vi.fn(), anthropic: vi.fn(), construct: vi.fn() }))
vi.mock('openai', () => ({ default: class { constructor(options) { sdk.construct(options); this.responses = { create: sdk.responses }; this.chat = { completions: { create: sdk.openai } } } } }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: sdk.anthropic } } }))
import { invokeJsonWithFallback, invokeTextWithFallback } from '../utils/aiProviders.js'
import { isTransientLlmFailure } from '../services/hamilton/portalSync/llmPageExtract.js'
import { clearRecentLogs, getRecentLogs } from '../utils/logger.js'
import { circuitBlocked, recordPaidFailure } from '../utils/paidAiRoutes.js'
const completion = (content = '{"ok":true}', finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }] })
const config = (routes) => vi.stubEnv('AI_PAID_ROUTES', JSON.stringify(routes))
const routes = [{ provider: 'openai', model: 'gpt-4.1' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'openai', model: 'gpt-4.1-mini' }]
let state
const run = (options = {}) => invokeJsonWithFallback({ prompt: 'fixture', freeRoutes: [], paidCircuitState: state, ...options })
beforeEach(() => {
  vi.clearAllMocks(); clearRecentLogs(); state = new Map()
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key'); vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-anthropic')
  config(routes)
  sdk.openai.mockResolvedValue(completion()); sdk.anthropic.mockResolvedValue({ content: [{ text: '{"ok":true}' }] })
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })
describe('ranked paid gateway', () => {
  it('keeps an earlier retryable outage after later models reject the request', async () => {
    sdk.openai.mockRejectedValueOnce(Object.assign(new Error('temporarily unavailable'), { status: 503 }))
      .mockRejectedValue(Object.assign(new Error('unsupported request'), { status: 400 }))
    sdk.anthropic.mockRejectedValue(Object.assign(new Error('invalid api key'), { status: 401 }))
    const result = await run()
    expect(isTransientLlmFailure(result)).toBe(true)
  })

  it('keeps Anthropic overload retryable with sanitized status', async () => {
    sdk.openai.mockRejectedValue(new Error('unavailable'))
    sdk.anthropic.mockRejectedValue(Object.assign(new Error('overloaded private-document-text'), { status: 529 }))
    const result = await run()
    expect(result.anthropicError).toMatchObject({ status: 529 })
    expect(isTransientLlmFailure(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-document-text')
  })
  it('does not cool an entire account when only one model returns 403', async () => {
    sdk.openai.mockRejectedValueOnce(Object.assign(new Error('model access denied'), { status: 403 }))
    sdk.anthropic.mockRejectedValue(new Error('unavailable'))
    expect(await run()).toMatchObject({ ok: true, model: 'gpt-4.1-mini' })
  })
  it('preserves retryability through account cooldown without repeating exhausted calls', async () => {
    sdk.openai.mockRejectedValue(Object.assign(new Error('insufficient_quota private-account'), { status: 429 }))
    sdk.anthropic.mockRejectedValue(Object.assign(new Error('credit balance too low private-account'), { status: 400 }))
    const first = await run()
    const second = await run()
    expect(isTransientLlmFailure(first)).toBe(true)
    expect(isTransientLlmFailure(second)).toBe(true)
    expect(second.openaiError).toMatchObject({ status: 429 })
    expect(second.anthropicError).toMatchObject({ status: 400 })
    expect(sdk.openai).toHaveBeenCalledTimes(1)
    expect(sdk.anthropic).toHaveBeenCalledTimes(1)
    expect(JSON.stringify([...state.values()])).not.toContain('private-account')
  })

  it('promotes the other primary ahead of consecutive models from the first provider', async () => {
    config([routes[0], routes[2], routes[1]])
    sdk.openai.mockRejectedValueOnce(new Error('unavailable'))
    expect(await run()).toMatchObject({ provider: 'anthropic' })
    expect(sdk.openai).toHaveBeenCalledTimes(1)
  })
  it('preserves explicit null opt-out with configured OpenAI routes', async () => {
    expect(await run({ openai: null })).toMatchObject({ provider: 'anthropic' })
    expect(sdk.openai).not.toHaveBeenCalled()
  })
  it('bounds cached failures and expires them without storing credentials', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 400; i++) recordPaidFailure(state, { account: String(i), model: 'fixture' }, new Error('unavailable'))
    expect(state.size).toBe(256)
    vi.advanceTimersByTime(5001)
    expect(circuitBlocked(state, { account: '399', model: 'fixture' })).toBe(false)
    expect(state.size).toBe(0)
  })
  it('honors short Retry-After without treating rate limit as account exhaustion', async () => {
    vi.useFakeTimers()
    sdk.openai.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429, headers: new Headers({ 'retry-after': '2' }) }))
    sdk.anthropic.mockRejectedValue(new Error('unavailable'))
    expect(await run()).toMatchObject({ model: 'gpt-4.1-mini' })
    vi.advanceTimersByTime(2001)
    expect(await run()).toMatchObject({ model: 'gpt-4.1' })
  })
  it('does not restart a zero budget or continue after cancellation', async () => {
    expect(await run({ timeoutMs: 0 })).toMatchObject({ ok: false })
    expect(sdk.openai).not.toHaveBeenCalled()
    vi.useFakeTimers()
    const controller = new AbortController()
    sdk.openai.mockImplementationOnce(() => new Promise(() => {}))
    const pending = run({ signal: controller.signal })
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    expect(await pending).toMatchObject({ aborted: true })
    expect(sdk.openai.mock.calls[0][1].signal.aborted).toBe(true)
    expect(sdk.anthropic).not.toHaveBeenCalled()
  })
  it('rejects truncated free JSON even when its prefix parses', async () => {
    config([])
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const create = vi.fn().mockResolvedValue(completion('{"partial":true}', 'length'))
    expect(await run({ openai: null, freeRoutes: [{ model: 'fixture', base_url: 'https://fixture.invalid/v1' }], freeClientFactory: () => ({ chat: { completions: { create } } }) })).toMatchObject({ ok: false })
  })
  it('rejects malformed free JSON with a valid object prefix', async () => {
    config([])
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const create = vi.fn().mockResolvedValue(completion('{"partial":true} trailing garbage'))
    expect(await run({ openai: null, freeRoutes: [{ model: 'fixture', base_url: 'https://fixture.invalid/v1' }], freeClientFactory: () => ({ chat: { completions: { create } } }) })).toMatchObject({ ok: false })
  })
  it('uses configured primary then other primary before remaining ranked models', async () => {
    sdk.openai.mockRejectedValueOnce(new Error('unavailable'))
    expect(await run()).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6', billing_mode: 'paid_api' })
    expect(sdk.openai.mock.calls[0][0].model).toBe('gpt-4.1')
  })
  it('supports Anthropic first', async () => {
    config([routes[1], routes[0], routes[2]])
    sdk.anthropic.mockRejectedValue(new Error('unavailable'))
    expect(await run()).toMatchObject({ provider: 'openai', model: 'gpt-4.1' })
    expect(sdk.anthropic.mock.invocationCallOrder[0]).toBeLessThan(sdk.openai.mock.invocationCallOrder[0])
  })
  it('tries the next paid model before free after both primary failures', async () => {
    sdk.openai.mockRejectedValueOnce(new Error('unavailable')); sdk.anthropic.mockRejectedValue(new Error('unavailable'))
    expect(await run()).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini' })
    expect(sdk.openai.mock.calls.map(([a]) => a.model)).toEqual(['gpt-4.1', 'gpt-4.1-mini'])
  })
  it('reaches existing free routes only after the paid ladder', async () => {
    sdk.openai.mockRejectedValue(new Error('unavailable')); sdk.anthropic.mockRejectedValue(new Error('unavailable'))
    const create = vi.fn().mockResolvedValue(completion())
    const result = await run({ freeRoutes: [{ id: 'fixture', model: 'free', base_url: 'http://fixture.invalid/v1' }], freeClientFactory: () => ({ chat: { completions: { create } } }) })
    expect(result).toMatchObject({ provider: 'free:fixture', model: 'free', billing_mode: 'free_or_local' })
    expect(sdk.openai).toHaveBeenCalledTimes(2)
  })
  it('skips exhausted account models, expires cooldown, and invalidates on rotation', async () => {
    vi.useFakeTimers()
    sdk.openai.mockRejectedValue(Object.assign(new Error('insufficient_quota private-secret'), { status: 429 }))
    sdk.anthropic.mockRejectedValue(new Error('unavailable'))
    await run(); expect(sdk.openai).toHaveBeenCalledTimes(1)
    await run(); expect(sdk.openai).toHaveBeenCalledTimes(1)
    vi.stubEnv('OPENAI_API_KEY', 'rotated-key'); await run(); expect(sdk.openai).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300001); await run(); expect(sdk.openai).toHaveBeenCalledTimes(3)
    expect(JSON.stringify([...state])).not.toContain('key')
  })
  it('rate limit is model scoped and Retry-After is bounded', async () => {
    vi.useFakeTimers()
    sdk.openai.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '999999' } }))
    sdk.anthropic.mockRejectedValue(new Error('unavailable'))
    expect(await run()).toMatchObject({ model: 'gpt-4.1-mini' })
    sdk.openai.mockClear(); await run(); expect(sdk.openai.mock.calls[0][0].model).toBe('gpt-4.1-mini')
    await vi.advanceTimersByTimeAsync(300001); sdk.openai.mockClear(); await run(); expect(sdk.openai.mock.calls[0][0].model).toBe('gpt-4.1')
  })
  it('times out only the model, aborts its request, and reserves later paid time', async () => {
    vi.useFakeTimers()
    sdk.openai.mockImplementationOnce(() => new Promise(() => {})); sdk.anthropic.mockRejectedValue(new Error('unavailable'))
    const pending = run({ timeoutMs: 10000 })
    await vi.advanceTimersByTimeAsync(10000)
    expect(await pending).toMatchObject({ ok: true, model: 'gpt-4.1-mini' })
    expect(sdk.openai.mock.calls[0][1].signal.aborted).toBe(true)
  })
  it.each(['', 'garbage', '{"ok":true} trailing garbage'])('rejects invalid JSON %j without accepting it', async (content) => {
    sdk.openai.mockResolvedValueOnce(completion(content))
    expect(await run()).toMatchObject({ provider: 'anthropic', billing_mode: 'paid_api' })
  })
  it('rejects empty text and Anthropic truncated JSON', async () => {
    sdk.openai.mockResolvedValueOnce(completion(' '))
    expect(await invokeTextWithFallback({ prompt: 'fixture', freeRoutes: [], paidCircuitState: state })).toMatchObject({ provider: 'anthropic' })
    config([routes[1], routes[0]])
    sdk.anthropic.mockResolvedValue({ stop_reason: 'max_tokens', content: [{ text: '{"partial":true}' }] })
    expect(await run({ paidCircuitState: new Map() })).toMatchObject({ provider: 'openai' })
  })
  it('uses reasoning parameters and never sends Responses routes to chat', async () => {
    config([{ provider: 'openai', model: 'gpt-5.4' }])
    await run()
    expect(sdk.openai.mock.calls[0][0]).toMatchObject({ max_completion_tokens: 1200 })
    expect(sdk.openai.mock.calls[0][0]).not.toHaveProperty('temperature')
    config([{ provider: 'openai', model: 'gpt-5.4-pro', api: 'responses' }]); sdk.openai.mockClear()
    await run(); expect(sdk.openai.mock.calls.some(([a]) => a.model === 'gpt-5.4-pro')).toBe(false)
  })
  it('allows only dedicated compatible credentials and excludes raw errors from logs', async () => {
    vi.stubEnv('PAID_AI_ROUTE_FIXTURE_API_KEY', 'dedicated-secret')
    config([{ provider: 'compatible', model: 'fixture-model', base_url: 'https://paid.example.test/v1', api_key_env: 'DATABASE_URL' }, { provider: 'compatible', model: 'fixture-model', base_url: 'https://paid.example.test/v1', api_key_env: 'PAID_AI_ROUTE_FIXTURE_API_KEY' }])
    sdk.openai.mockRejectedValue(new Error('private-provider-message dedicated-secret')); sdk.anthropic.mockRejectedValue(new Error('private-provider-message'))
    await run()
    expect(sdk.construct.mock.calls.some(([a]) => a.apiKey === 'dedicated-secret')).toBe(true)
    expect(sdk.construct.mock.calls.filter(([a]) => a.baseURL).length).toBe(1)
    const logs = JSON.stringify(getRecentLogs())
    expect(logs).not.toContain('private-provider-message'); expect(logs).not.toContain('dedicated-secret')
  })
})

const nativeResponse = (overrides = {}) => ({ status: 'completed', model: 'gpt-6-astra', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"ok":true}' }] }], ...overrides })
const responseRoute = { provider: 'openai', model: 'gpt-6-astra', api: 'responses', reasoning_effort: 'low' }
describe('native API options and recovery', () => {
  beforeEach(() => { config([responseRoute]); sdk.responses.mockResolvedValue(nativeResponse()) })
  it('includes the JSON instruction in Responses input, not only instructions', async () => {
    sdk.responses.mockImplementation(async body => {
      if (!/json/i.test(JSON.stringify(body.input))) {
        throw Object.assign(new Error("Response input must contain the word json"), { status: 400, param: 'input' })
      }
      return nativeResponse()
    })
    expect(await run({ prompt: 'Extract the funding fields.', system: 'Return JSON.' })).toMatchObject({ ok: true, provider: 'openai' })
    expect(sdk.responses.mock.calls[0][0].input).toContain('Extract the funding fields.')
  })
  it('uses native Responses JSON options and preserves model and usage', async () => {
    expect(await run({ system: 'grounding', maxTokens: 1800 })).toMatchObject({ ok: true, model: 'gpt-6-astra', usage: { input_tokens: 10, output_tokens: 20 } })
    expect(sdk.responses.mock.calls[0][0]).toMatchObject({ model: 'gpt-6-astra', max_output_tokens: 1800, store: false, instructions: expect.stringContaining('grounding'), input: expect.stringContaining('fixture'), text: { format: { type: 'json_object' } }, reasoning: { effort: 'low' } })
    expect(sdk.openai).not.toHaveBeenCalled()
  })
  it('uses Responses text mode without a JSON format and retains returned model', async () => {
    const response = nativeResponse({ model: 'gpt-6-astra-snapshot' }); response.output[0].content[0].text = 'answer'
    sdk.responses.mockResolvedValue(response)
    expect(await invokeTextWithFallback({ prompt: 'fixture', freeRoutes: [], paidCircuitState: state })).toMatchObject({ text: 'answer', model: 'gpt-6-astra-snapshot' })
    expect(sdk.responses.mock.calls[0][0]).not.toHaveProperty('text')
    expect(sdk.responses.mock.calls[0][0]).not.toHaveProperty('temperature')
  })
  it('preserves explicit null during invalid configuration recovery', async () => {
    config([]); expect(await run({ openai: null })).toMatchObject({ provider: 'anthropic' })
    expect(sdk.openai).not.toHaveBeenCalled(); expect(sdk.responses).not.toHaveBeenCalled()
  })
  it.each([
    { ...responseRoute, reasoning_effort: 'invented' },
    { provider: 'anthropic', model: 'claude-haiku-4-5', thinking: 'adaptive' },
    { provider: 'anthropic', model: 'claude-fable-5-1', thinking: 'adaptive', effort: 'invented' },
    { provider: 'anthropic', model: 'claude-fable-5-1', effort: 'high' },
  ])('recovers defaults for unsupported native options %#', async route => {
    config([route]); expect(await run()).toMatchObject({ ok: true })
    expect(sdk.responses).not.toHaveBeenCalled()
    expect(sdk.openai.mock.calls[0][0]).not.toHaveProperty('reasoning')
    expect(JSON.stringify(getRecentLogs())).toContain('paid_routes_default_recovery')
  })
  it.each(['incomplete', 'failed', 'in_progress', undefined])('rejects noncompleted status %s', async status => {
    sdk.responses.mockResolvedValue(nativeResponse({ status }))
    expect(await run()).toMatchObject({ ok: false })
  })
  it.each([
    [], [{ type: 'function_call', output: '{"ok":true}' }],
    [{ type: 'message', role: 'user', status: 'completed', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
    [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
    [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }, { type: 'output_text', text: '{"ok":true}' }] }],
  ])('rejects missing, tool, incomplete and refusal outputs %#', async (...items) => {
    sdk.responses.mockResolvedValue(nativeResponse({ output: items }))
    expect(await run()).toMatchObject({ ok: false })
  })
  it.each(['', '{"ok":true} garbage'])('rejects empty/malformed text %j', async text => {
    const response = nativeResponse(); response.output[0].content[0].text = text
    sdk.responses.mockResolvedValue(response)
    expect(await run()).toMatchObject({ ok: false })
  })
  it('retries only one output-token truncation within the same budget and aggregates usage', async () => {
    sdk.responses.mockResolvedValueOnce(nativeResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }))
    expect(await run({ maxTokens: 1800 })).toMatchObject({ ok: true, usage: { input_tokens: 20, output_tokens: 40, total_tokens: 60 } })
    expect(sdk.responses.mock.calls.map(([r]) => r.max_output_tokens)).toEqual([1800, 3600])
  })
  it('rejects repeated truncation and does not retry without time', async () => {
    sdk.responses.mockResolvedValue(nativeResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }))
    expect(await run()).toMatchObject({ ok: false }); expect(sdk.responses).toHaveBeenCalledTimes(2)
    sdk.responses.mockClear()
    expect(await run({ timeoutMs: 900, paidCircuitState: new Map() })).toMatchObject({ ok: false }); expect(sdk.responses).toHaveBeenCalledTimes(1)
  })
  it('aborts Responses at the overall deadline', async () => {
    vi.useFakeTimers(); sdk.responses.mockImplementation(() => new Promise(() => {}))
    const pending = run({ timeoutMs: 1000 }); await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toMatchObject({ ok: false, timedOut: true })
    expect(sdk.responses.mock.calls[0][1].signal.aborted).toBe(true)
  })
  it.each([429, 401])('shares cooldown across API shapes for status %s', async status => {
    sdk.responses.mockRejectedValue(Object.assign(new Error('failure'), { status }))
    await run(); config([{ ...responseRoute, api: 'chat', reasoning_effort: undefined }]); await run()
    expect(sdk.openai).not.toHaveBeenCalled()
  })
  it.each(['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5'])('uses explicit adaptive thinking for %s', async model => {
    config([{ provider: 'anthropic', model, thinking: 'adaptive', effort: 'high' }]); await run()
    expect(sdk.anthropic.mock.calls[0][0]).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
    expect(sdk.anthropic.mock.calls[0][0]).not.toHaveProperty('temperature')
  })
  it('keeps Haiku defaults and omits unspecified adaptive effort', async () => {
    config([{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }]); await run()
    expect(sdk.anthropic.mock.calls[0][0]).toHaveProperty('temperature', 0.1)
    expect(sdk.anthropic.mock.calls[0][0]).not.toHaveProperty('thinking')
    config([{ provider: 'anthropic', model: 'claude-fable-5-1', thinking: 'adaptive' }]); await run()
    expect(sdk.anthropic.mock.calls[1][0]).not.toHaveProperty('output_config')
  })
  it.each(['', '[]', '{}', 'private-secret-invalid', '[{"provider":"openai","model":"gpt-6-astra","api":"responses","reasoning_effort":"none"}]'])('recovers native defaults for invalid config %#', async value => {
    vi.stubEnv('AI_PAID_ROUTES', value); sdk.openai.mockRejectedValue(new Error('unavailable'))
    expect(await run()).toMatchObject({ provider: 'anthropic' }); expect(sdk.openai).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(getRecentLogs())).not.toContain('private-secret-invalid')
    expect(JSON.stringify(getRecentLogs())).toContain('paid_routes_default_recovery')
  })
})

it('retains retryability when the final free route is rate-limited', () => {
  expect(isTransientLlmFailure({ ok: false, freeRouteErrors: [{ status: 429, message: 'rate_limited' }] })).toBe(true)
})


describe('bounded extraction task models retain their requested priority', () => {
  it('uses the task-specific fast native models before the general ranking only when explicitly requested', async () => {
    config([{ provider: 'openai', model: 'gpt-6-astra', api: 'responses', reasoning_effort: 'low' }, { provider: 'anthropic', model: 'claude-fable-5-1' }])
    const result = await run({ preferTaskModels: true, openaiModel: 'gpt-4o-mini', anthropicModel: 'claude-haiku-4-5' })
    expect(result).toMatchObject({ ok: true, provider: 'openai', model: 'gpt-4o-mini' })
    expect(sdk.openai).toHaveBeenCalledTimes(1)
    expect(sdk.responses).not.toHaveBeenCalled()
  })
  it('preserves general ranking when no task priority was requested', async () => {
    config([{ provider: 'openai', model: 'gpt-4.1' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }])
    expect(await run({ openaiModel: 'gpt-4o-mini' })).toMatchObject({ model: 'gpt-4.1' })
  })
  it('falls from exhausted task providers to an actual free transport without retrying their account models', async () => {
    config([{ provider: 'openai', model: 'gpt-6-astra', api: 'responses' }, { provider: 'anthropic', model: 'claude-fable-5-1' }])
    const quota = Object.assign(new Error('insufficient_quota'), { status: 429 })
    sdk.openai.mockRejectedValue(quota); sdk.responses.mockRejectedValue(quota)
    sdk.anthropic.mockRejectedValue(Object.assign(new Error('credit balance too low'), { status: 400 }))
    const create = vi.fn(async () => completion('{"free_worked":true}'))
    const result = await run({ preferTaskModels: true, openaiModel: 'gpt-4o-mini', anthropicModel: 'claude-haiku-4-5', freeRoutes: [{ id: 'qwen', model: 'qwen/qwen3.8-27b', base_url: 'https://fixture.invalid/v1' }], freeClientFactory: () => ({chat:{completions:{create}}}) })
    expect(result).toMatchObject({ provider: 'free:qwen', billing_mode: 'free_or_local', json: { free_worked: true } })
    expect(sdk.openai).toHaveBeenCalledTimes(1)
    expect(sdk.responses).not.toHaveBeenCalled()
    expect(sdk.anthropic).toHaveBeenCalledTimes(1)
  })
})
