import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
const bridge = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../services/ownerAi/ownerAiBroker.js', () => ({ tryOwnerSubscription: bridge.run }))
const { invokeJsonWithFallback, invokeTextWithFallback } = await import('../utils/aiProviders.js')
const { runWithOwnerAiScope } = await import('../services/ownerAi/ownerAiScope.js')
let create
const ownerRequest = () => ({
  ctx: { identityResolved: true, isAdmin: true, userId: 'owner-user', email: 'owner@example.test' },
  user: { userId: 'owner-user' }, res: new EventEmitter(),
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('ADMIN_EMAIL', 'owner@example.test')
  vi.stubEnv('AGENT_CONTROL_ADMIN_EMAIL', '')
  vi.stubEnv('OWNER_AI_USER_ID', '')
  vi.stubEnv('OWNER_AI_ALLOW_PAID_FALLBACK', 'true')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('AI_PAID_ROUTES', '')
  vi.stubEnv('FREE_AI_ROUTES', '')
  vi.stubEnv('OWNER_AI_SUBSCRIPTION_TIMEOUT_MS', '10000')
  bridge.run.mockReset().mockReturnValue(null)
  create = vi.fn(async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"answer":42}' } }], usage: {} }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
const opts = () => ({ openai: { chat: { completions: { create } } }, prompt: 'Return an answer', timeoutMs: 1000 })
it('owner JSON uses confirmed subscription output without an API call', async () => {
  const receipt = { ok: true, provider: 'subscription:codex', model: 'gpt-6-astra', billing_mode: 'subscription', json: { answer: 42 }, raw: '{"answer":42}' }
  bridge.run.mockResolvedValue(receipt)
  expect(await runWithOwnerAiScope(ownerRequest(), () => invokeJsonWithFallback(opts()))).toEqual(receipt)
  expect(create).not.toHaveBeenCalled()
  expect(bridge.run.mock.calls[0][0]).toMatchObject({ format: 'json', timeoutMs: 500 })
})
it('owner text uses confirmed subscription output without an API call', async () => {
  bridge.run.mockResolvedValue({ ok: true, provider: 'subscription:codex', billing_mode: 'subscription', text: 'answer' })
  expect(await runWithOwnerAiScope(ownerRequest(), () => invokeTextWithFallback(opts()))).toMatchObject({ text: 'answer', billing_mode: 'subscription' })
  expect(create).not.toHaveBeenCalled()
})
it('ordinary callers never ask the subscription broker', async () => {
  expect(await invokeJsonWithFallback(opts())).toMatchObject({ provider: 'openai', billing_mode: 'paid_api' })
  expect(bridge.run).not.toHaveBeenCalled()
})
it('offline subscription continues into the paid ladder', async () => {
  expect(await runWithOwnerAiScope(ownerRequest(), () => invokeJsonWithFallback(opts()))).toMatchObject({ provider: 'openai' })
  expect(bridge.run).toHaveBeenCalledTimes(1)
})
it('a broken subscription executor is bounded and leaves API time', async () => {
  bridge.run.mockReturnValue(new Promise(() => {}))
  const started = Date.now()
  const promise = runWithOwnerAiScope(ownerRequest(), () => invokeJsonWithFallback(opts()))
  await vi.advanceTimersByTimeAsync(501)
  expect(await promise).toMatchObject({ provider: 'openai' })
  expect(create).toHaveBeenCalledTimes(1)
  expect(Date.now() - started).toBe(501)
})
it('subscription and API share one original deadline', async () => {
  bridge.run.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(null), 400)))
  create.mockImplementation(() => new Promise(() => {}))
  const started = Date.now()
  const promise = runWithOwnerAiScope(ownerRequest(), () => invokeJsonWithFallback(opts()))
  await vi.advanceTimersByTimeAsync(1001)
  expect(await promise).toMatchObject({ ok: false })
  expect(Date.now() - started).toBe(1001)
})
it('closing the owner response cancels execution and does not charge the API fallback', async () => {
  bridge.run.mockReturnValue(new Promise(() => {}))
  const req = ownerRequest()
  const promise = runWithOwnerAiScope(req, () => invokeJsonWithFallback(opts()))
  req.res.emit('close')
  expect(await promise).toMatchObject({ ok: false, aborted: true })
  expect(create).not.toHaveBeenCalled()
})
it('zero budget and already-aborted requests never create subscription jobs', async () => {
  expect(await runWithOwnerAiScope(ownerRequest(), () => invokeJsonWithFallback({ ...opts(), timeoutMs: 0 }))).toMatchObject({ ok: false })
  expect(await runWithOwnerAiScope(ownerRequest(), () => invokeJsonWithFallback({ ...opts(), signal: AbortSignal.abort() }))).toMatchObject({ ok: false, aborted: true })
  expect(bridge.run).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})
it('later work inherited from a closed owner response cannot start a paid fallback', async () => {
  const req = ownerRequest()
  await runWithOwnerAiScope(req, async () => {
    req.res.emit('finish')
    expect(await invokeJsonWithFallback(opts())).toMatchObject({ ok: false, aborted: true })
    expect(create).not.toHaveBeenCalled()
  })
})


it('the owner can prohibit metered fallback and still use a free model', async () => {
  vi.stubEnv('OWNER_AI_ALLOW_PAID_FALLBACK', 'false')
  const freeCreate = vi.fn(async () => ({ choices:[{finish_reason:'stop',message:{content:'{"answer":42}'}}] }))
  const result = await runWithOwnerAiScope(ownerRequest(), () => invokeJsonWithFallback({ ...opts(), freeRoutes:[{id:'owner-free',model:'fixture',base_url:'https://fixture.invalid/v1'}],freeClientFactory:()=>({chat:{completions:{create:freeCreate}}}) }))
  expect(result).toMatchObject({ provider:'free:owner-free',billing_mode:'free_or_local' })
  expect(create).not.toHaveBeenCalled()
})
it('owner no-metered policy does not alter ordinary customer routing', async () => {
  vi.stubEnv('OWNER_AI_ALLOW_PAID_FALLBACK', 'false')
  expect(await invokeJsonWithFallback(opts())).toMatchObject({provider:'openai',billing_mode:'paid_api'})
})

it('owner metered fallback is opt-in, not the default', async () => {
  vi.stubEnv('OWNER_AI_ALLOW_PAID_FALLBACK', '')
  expect(await runWithOwnerAiScope(ownerRequest(), () => invokeJsonWithFallback(opts()))).toMatchObject({ok:false})
  expect(create).not.toHaveBeenCalled()
})
