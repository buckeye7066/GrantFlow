/**
 * Shared live web-search engine.
 *
 * One `searchWeb(query)` entry point that returns normalized
 * `[{ url, title, snippet }]` results, preferring Brave (higher-quality, keyed)
 * and falling back to DuckDuckGo HTML scraping (no key, best-effort). Both
 * back-ends are failure-tolerant: any error or non-OK response yields `[]`,
 * never a throw, so callers can merge results without guarding every call.
 *
 * This exists so profile-driven discovery of LOCAL/non-federal funding (which
 * has no public API) shares one definition of "search the web" instead of each
 * crawler re-implementing scraping + result hygiene. The DuckDuckGo parsing
 * mirrors the proven selectors in itemFundingCrawler.searchWebForItem.
 */

import * as cheerio from 'cheerio'
import { getWithRetry } from './httpClient.js'
import { makeBraveSearchProvider } from '../yana/webSearchProvider.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:webSearchEngine')

// Hosts that are never a real funder/program page: search-engine SERPs, social,
// video, and large retailers. Mirrors itemFundingCrawler's skip list.
const SKIP_SUBSTRINGS = [
  'google.com/search', 'bing.com/search', 'duckduckgo.com', 'youtube.com/watch',
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'pinterest.com',
  'amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'reddit.com', 'tiktok.com',
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Brave provider is created once (it throws without a key). Cache the attempt so
// we don't re-check the env / re-construct on every query.
let _brave = null
let _braveResolved = false
function getBraveProvider() {
  if (_braveResolved) return _brave
  _braveResolved = true
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      _brave = makeBraveSearchProvider({ count: 8 })
      log.info('[webSearchEngine] Brave search provider active')
    } catch (err) {
      log.warn(`[webSearchEngine] Brave provider unavailable: ${err?.message ?? err}`)
      _brave = null
    }
  }
  return _brave
}

/** Reset cached provider state — test seam only. */
export function _resetWebSearchEngineForTests() {
  _brave = null
  _braveResolved = false
}

function shouldSkip(url) {
  const u = String(url || '').toLowerCase()
  if (!/^https?:\/\//.test(u)) return true
  return SKIP_SUBSTRINGS.some((s) => u.includes(s))
}

async function duckDuckGoSearch(query, count, timeoutMs) {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await getWithRetry(
    searchUrl,
    { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.5' } },
    { timeoutMs, retries: 1 },
  )
  if (!response?.data) return []

  const $ = cheerio.load(response.data)
  const out = []
  const seen = new Set()
  $('.result, .results_links').each((_i, elem) => {
    if (out.length >= count) return
    const $elem = $(elem)
    const titleElem = $elem.find('.result__title a, .result__a')
    const title = titleElem.text().trim()
    const href = titleElem.attr('href') || ''
    const snippet = $elem.find('.result__snippet').text().trim()
    if (!title || !href) return

    // DuckDuckGo wraps the real URL in a `uddg=` redirect param.
    let url = href
    if (href.includes('uddg=')) {
      try {
        url = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg') || href
      } catch { url = href }
    }
    try { url = decodeURIComponent(url) } catch { /* keep as-is */ }

    if (shouldSkip(url)) return
    const key = url.toLowerCase().replace(/\/$/, '')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ url, title, snippet })
  })
  return out
}

/**
 * Search the live web for a single query.
 * @param {string} query
 * @param {Object} [opts]
 * @param {number} [opts.count=8]       Max results to return.
 * @param {number} [opts.timeoutMs=8000] Per-query network budget (DuckDuckGo path).
 * @returns {Promise<Array<{url:string,title:string,snippet:string}>>}
 */
export async function searchWeb(query, { count = 8, timeoutMs = 8000 } = {}) {
  const q = String(query || '').trim()
  if (!q) return []

  const brave = getBraveProvider()
  if (brave) {
    try {
      const results = await brave({ query: q })
      if (Array.isArray(results) && results.length) {
        return results
          .filter((r) => r?.url && !shouldSkip(r.url))
          .slice(0, count)
          .map((r) => ({ url: r.url, title: r.title || '', snippet: r.snippet || '' }))
      }
    } catch (err) {
      log.warn(`[webSearchEngine] Brave search failed for "${q}": ${err?.message ?? err}`)
    }
  }

  try {
    return await duckDuckGoSearch(q, count, timeoutMs)
  } catch (err) {
    log.warn(`[webSearchEngine] DuckDuckGo search failed for "${q}": ${err?.message ?? err}`)
    return []
  }
}

export default { searchWeb }
