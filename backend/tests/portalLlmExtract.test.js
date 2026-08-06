/**
 * portalLlmExtract.test.js
 *
 * Unit tests for the selector-independent portal extractor
 * (backend/services/hamilton/portalSync/llmPageExtract.js). The Playwright page
 * and the extractor are both mocked so no browser or AI provider is touched.
 *
 * Asserts:
 *   1. valid model JSON  -> awards + fields returned, parsed/coerced.
 *   2. malformed JSON    -> empty arrays + honest notFound (no fabrication).
 *   3. production/default path never reads or relays authenticated page data.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// This mock is injected directly into the test-only fixture seam. Production
// code no longer imports or calls the canonical provider wrapper.
const invokeJsonWithFallback = vi.fn()
const getOpenAIOptional = vi.fn(() => null)
vi.mock('../utils/aiProviders.js', () => ({
  invokeJsonWithFallback: (...args) => invokeJsonWithFallback(...args),
  getOpenAIOptional: (...args) => getOpenAIOptional(...args),
}))

const { extractPortalDataWithLLM } = await import('../services/hamilton/portalSync/llmPageExtract.js')

/** Minimal fake Playwright page with controllable visible text + links. */
function makePage({ text = 'AWARD: HOPE Scholarship $4,000', links = [], url = 'https://pipelinemt.mtsu.edu/aid' } = {}) {
  return {
    url: () => url,
    goto: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    // page.evaluate is used for innerText, location.origin, and link scraping.
    evaluate: vi.fn(async (fn) => {
      const src = String(fn)
      if (src.includes('location.origin')) return 'https://pipelinemt.mtsu.edu'
      if (src.includes('querySelectorAll')) return links
      return text
    }),
  }
}

describe('extractPortalDataWithLLM', () => {
  beforeEach(() => {
    invokeJsonWithFallback.mockReset()
    getOpenAIOptional.mockReset()
    getOpenAIOptional.mockReturnValue(null)
    process.env.ANTHROPIC_API_KEY = 'sentinel-provider-key'
    delete process.env.PORTAL_SYNC_LLM_EXTRACT
  })

  const fixtureOptions = () => ({
    _syntheticFixture: true,
    _invoke: (...args) => invokeJsonWithFallback(...args),
  })

  it('returns awards and fields from valid model JSON', async () => {
    invokeJsonWithFallback.mockResolvedValue({
      ok: true,
      provider: 'anthropic',
      json: {
        awards: [
          { title: 'HOPE Scholarship', amount: '4000', status: 'offered', sponsor: 'MTSU', sourceUrl: 'https://pipelinemt.mtsu.edu/aid' },
          { title: '', amount: 100 }, // dropped: no title
        ],
        fields: [
          { sectionKey: 'education', field: 'act_score', value: '28' },
          { sectionKey: '', field: 'x', value: '1' }, // dropped: no sectionKey
        ],
      },
    })

    const res = await extractPortalDataWithLLM(makePage(), fixtureOptions())
    expect(res.awards).toHaveLength(1)
    expect(res.awards[0]).toMatchObject({ title: 'HOPE Scholarship', amount: 4000, status: 'offered', sponsor: 'MTSU' })
    expect(res.fields).toHaveLength(1)
    expect(res.fields[0]).toMatchObject({ sectionKey: 'education', field: 'act_score', value: '28' })
    expect(res.notFound).toHaveLength(0)
  })

  it('returns empty + notFound when the model returns malformed/no JSON', async () => {
    invokeJsonWithFallback.mockResolvedValue({ ok: false, json: null, anthropicError: 'returned invalid JSON' })

    const res = await extractPortalDataWithLLM(makePage(), fixtureOptions())
    expect(res.awards).toEqual([])
    expect(res.fields).toEqual([])
    expect(res.notFound.length).toBeGreaterThan(0)
    expect(res.notFound.join(' ')).toMatch(/no parseable JSON/i)
    // Honesty: never fabricates.
  })

  it('never reads or invokes a provider without a future server-verified disclosure consent', async () => {
    process.env.PORTAL_SYNC_LLM_EXTRACT = 'true'
    getOpenAIOptional.mockReturnValue({ apiKey: 'also-present' })
    const page = makePage({
      text: 'SENTINEL_SSN_123_45_6789 SENTINEL_INCOME_90000',
      url: 'https://portal.example/aid?resume=SENTINEL_TOKEN',
    })

    const res = await extractPortalDataWithLLM(page)
    expect(res.awards).toEqual([])
    expect(res.fields).toEqual([])
    expect(res.raw.attempted).toBe(false)
    expect(res.notFound.join(' ')).toMatch(/server-verified per-profile disclosure consent/i)
    expect(page.evaluate).not.toHaveBeenCalled()
    expect(invokeJsonWithFallback).not.toHaveBeenCalled()
    expect(JSON.stringify(res)).not.toContain('SENTINEL_')
  })

  it('reports notFound when the model returns valid JSON but zero awards', async () => {
    invokeJsonWithFallback.mockResolvedValue({ ok: true, provider: 'anthropic', json: { awards: [], fields: [] } })

    const res = await extractPortalDataWithLLM(makePage(), fixtureOptions())
    expect(res.awards).toEqual([])
    expect(res.notFound.join(' ')).toMatch(/no financial-aid awards/i)
  })
})
