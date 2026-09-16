import { describe, expect, it, vi } from 'vitest'
import { citationResults, makeOpenAIWebSearchProvider } from '../services/shared/openaiWebSearchProvider.js'

function fixture() {
  return {
    output_text: 'Official funding pages for the requested community program.',
    output: [{ type: 'message', content: [{ type: 'output_text', annotations: [
      { type: 'url_citation', url: 'https://agency.gov/grants/program', title: 'Agency Program' },
      { type: 'url_citation', url: 'https://agency.gov/grants/program/', title: 'duplicate' },
      { type: 'url_citation', url: 'https://foundation.org/apply', title: 'Foundation Award' },
    ] }] }],
  }
}

describe('OpenAI official web-search provider', () => {
  it('returns only deduplicated URLs cited by the tool response', () => {
    expect(citationResults(fixture(), 8)).toEqual([
      expect.objectContaining({ url: 'https://agency.gov/grants/program', title: 'Agency Program' }),
      expect.objectContaining({ url: 'https://foundation.org/apply', title: 'Foundation Award' }),
    ])
  })

  it('forces web search and caps the returned source count', async () => {
    const create = vi.fn().mockResolvedValue(fixture())
    const provider = makeOpenAIWebSearchProvider({ client: { responses: { create } }, model: 'test-model' })
    expect(await provider({ query: 'Tennessee nonprofit transportation grants', count: 1 })).toHaveLength(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'test-model',
      tools: [{ type: 'web_search', search_context_size: 'low' }],
      tool_choice: { type: 'web_search' },
      include: ['web_search_call.action.sources'],
    }))
  })
})
