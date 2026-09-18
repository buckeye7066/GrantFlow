import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const transport = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../services/shared/httpClient.js', () => ({ getWithRetry: transport.get }))
import { makeGoogleCseProvider } from '../services/shared/googleCseProvider.js'
import { makeSearxngProvider } from '../services/shared/searxngProvider.js'
import { makeOpenAIWebSearchProvider } from '../services/shared/openaiWebSearchProvider.js'
import { makeBraveSearchProvider } from '../services/yana/webSearchProvider.js'
let create, fetch
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('GOOGLE_CSE_KEY', 'fixture'); vi.stubEnv('GOOGLE_CSE_CX', 'fixture')
  transport.get.mockResolvedValue({ status: 200, data: { items: [], results: [], unresponsive_engines: [] } })
  create = vi.fn(async () => ({ output: [] }))
  fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ web: { results: [] } }) }))
})
afterEach(() => vi.unstubAllEnvs())
function provider(name) {
  if (name === 'google') return makeGoogleCseProvider()
  if (name === 'searxng') return makeSearxngProvider({ baseUrl: 'https://search.fixture.invalid' })
  if (name === 'openai') return makeOpenAIWebSearchProvider({ client: { responses: { create } } })
  return makeBraveSearchProvider({ apiKey: 'fixture', fetchImpl: fetch, minIntervalMs: 0, consumeBudget: async () => ({ allowed: true }) })
}
it.each(['google', 'searxng', 'openai', 'brave'])('%s never starts transport for an aborted caller', async name => {
  await expect(provider(name)({ query: 'youth grants', signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  expect(transport.get).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
})
it.each(['google', 'searxng', 'openai', 'brave'])('%s passes the signal to its real transport boundary', async name => {
  const controller = new AbortController()
  await provider(name)({ query: 'youth grants', signal: controller.signal })
  const call = name === 'openai' ? create.mock.calls[0] : name === 'brave' ? fetch.mock.calls[0] : transport.get.mock.calls[0]
  expect(call?.[1]?.signal).toBe(controller.signal)
})
