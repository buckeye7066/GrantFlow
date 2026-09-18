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
  // Tool-backed web search is materially slower than a plain completion. Keep
  // this below the acceptance preflight's outer deadline so the provider owns
  // the useful error instead of being abandoned mid-request.
  const openai = client || createOpenAIClient({ timeoutMs: 45_000, maxRetries: 1 }).openai
  const selectedModel = String(model || process.env.OPENAI_WEB_SEARCH_MODEL || DEFAULT_MODEL).trim()
  return async function openAIWebSearch({ query, count: requestedCount = count, signal = null } = {}) {
    signal?.throwIfAborted()
    const q = String(query || '').trim()
    if (!q) return []
    const limit = Math.max(1, Math.min(10, Number(requestedCount) || count))
    const request = {
      model: selectedModel,
      tools: [{ type: 'web_search', search_context_size: 'low' }],
      tool_choice: { type: 'web_search' },
      include: ['web_search_call.action.sources'],
      input: `Search the live web for: ${q}\nReturn only a concise list of the most relevant source pages. Prefer official funders and program pages.`,
    }
    const response = signal
      ? await openai.responses.create(request, { signal, maxRetries: 0 })
      : await openai.responses.create(request)
    signal?.throwIfAborted()
    return citationResults(response, limit)
  }
}
