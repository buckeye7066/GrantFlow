import { createOpenAIClient } from '../../utils/openaiClient.js'

const DEFAULT_MODEL = 'gpt-5-mini'

export function citationResults(response, count) {
  const out = []
  const seen = new Set()
  const answer = String(response?.output_text || '').trim()
  for (const item of response?.output || []) {
    if (item?.type !== 'message') continue
    for (const content of item.content || []) {
      if (content?.type !== 'output_text') continue
      for (const annotation of content.annotations || []) {
        if (annotation?.type !== 'url_citation' || !annotation.url) continue
        const key = String(annotation.url).toLowerCase().replace(/\/$/, '')
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          url: annotation.url,
          title: String(annotation.title || '').trim(),
          snippet: answer.slice(0, 1200),
        })
        if (out.length >= count) return out
      }
    }
  }
  return out
}

/** Official web-search fallback. Only tool-cited URLs leave this provider. */
export function makeOpenAIWebSearchProvider({ client = null, count = 8, model = null } = {}) {
  const openai = client || createOpenAIClient({ timeoutMs: 20_000, maxRetries: 1 }).openai
  const selectedModel = String(model || process.env.OPENAI_WEB_SEARCH_MODEL || DEFAULT_MODEL).trim()
  return async function openAIWebSearch({ query, count: requestedCount = count } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    const limit = Math.max(1, Math.min(10, Number(requestedCount) || count))
    const response = await openai.responses.create({
      model: selectedModel,
      tools: [{ type: 'web_search', search_context_size: 'low' }],
      tool_choice: { type: 'web_search' },
      include: ['web_search_call.action.sources'],
      input: `Search the live web for: ${q}\nReturn only a concise list of the most relevant source pages. Prefer official funders and program pages.`,
    })
    return citationResults(response, limit)
  }
}
