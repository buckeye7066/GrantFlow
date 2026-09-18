import { afterEach, expect, it, vi } from 'vitest'
const adapter = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ ok: true, json: { opportunities: [] } })) }))
vi.mock('../utils/aiProviders.js', () => ({ getOpenAIOptional: () => null, invokeJsonWithFallback: adapter.invoke }))
vi.mock('../crawler-os/blindPageFactExtractor.js', () => ({
  extractPageFactsBlind: async (_page, options) => {
    await options.llm({ system: 'fixture', prompt: 'fixture', signal: options.signal })
    return { opportunities: [] }
  },
}))
import { makeBlindShadow } from '../services/crawlerOsService.js'
afterEach(() => vi.unstubAllEnvs())
it('passes shadow cancellation into the shared AI gateway rather than abandoning live requests', async () => {
  vi.stubEnv('WEB_LANE_PROFILE_BLIND', 'true')
  const shadow = await makeBlindShadow()
  expect(shadow).not.toBeNull()
  const controller = new AbortController()
  await shadow.extractPage({ pageUrl: 'https://fixture.invalid', html: '<p>Public grant facts.</p>', signal: controller.signal })
  expect(adapter.invoke.mock.calls[0][0].signal).toBe(controller.signal)
})
