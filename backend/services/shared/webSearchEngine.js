/**
 * Shared live web-search engine.
 *
 * One `searchWeb(query)` entry point that returns normalized
 * `[{ url, title, snippet }]` results. Provider chain, in order:
 *
 *   1. SearXNG (self-hosted metasearch, PRIMARY) — keyless, unlimited, and
 *      reliable from a datacenter IP. Active when SEARXNG_URL is set. This is
 *      GrantFlow's "own Brave"; see docs/SEARXNG_SELF_HOST.md for the runbook.
 *   2. Brave Search API (fallback, only when BRAVE_SEARCH_API_KEY is set) —
 *      higher quality but a metered/capped paid plan, so it's a backstop.
 *   3. DuckDuckGo HTML scraping (last resort, no key) — DEAD from cloud IPs
 *      (202 anti-bot challenge), so in prod it no-ops; kept for local/dev.
 *
 * Every back-end is failure-tolerant: any error or non-OK response yields `[]`,
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
import { makeSearxngProvider } from './searxngProvider.js'
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

function isLiveSearchDisabledInTests() {
  const explicitAllow = String(process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS || '').toLowerCase() === 'true'
  if (explicitAllow) return false
  return process.env.GRANTFLOW_TEST_RUNNER === '1'
}

// Providers are created once (each throws without its config). Cache the attempt
// so we don't re-check the env / re-construct on every query.
let _searxng = null
let _searxngResolved = false
function getSearxngProvider() {
  if (_searxngResolved) return _searxng
  _searxngResolved = true
  if (process.env.SEARXNG_URL) {
    try {
      _searxng = makeSearxngProvider({ count: 8 })
      log.info('[webSearchEngine] SearXNG search provider active (primary)')
    } catch (err) {
      log.warn(`[webSearchEngine] SearXNG provider unavailable: ${err?.message ?? err}`)
      _searxng = null
    }
  }
  return _searxng
}

let _brave = null
let _braveResolved = false
function getBraveProvider() {
  if (_braveResolved) return _brave
  _braveResolved = true
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      _brave = makeBraveSearchProvider({ count: 8 })
      log.info('[webSearchEngine] Brave search provider active (fallback)')
    } catch (err) {
      log.warn(`[webSearchEngine] Brave provider unavailable: ${err?.message ?? err}`)
      _brave = null
    }
  }
  return _brave
}

/** Reset cached provider state — test seam only. */
export function _resetWebSearchEngineForTests() {
  _searxng = null
  _searxngResolved = false
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
  // DuckDuckGo serves a 202 anti-bot challenge (no result markup) to datacenter
  // / cloud IPs — exactly where this runs in prod. Detect it and warn ONCE-style
  // so "0 web results" is diagnosable as a blocked backend, not a silent miss.
  // The reliable server-side web backend is Brave (set BRAVE_SEARCH_API_KEY).
  const status = Number(response?.status)
  const body = String(response?.data || '')
  if (status && status !== 200) {
    log.warn(
      `[webSearchEngine] DuckDuckGo returned HTTP ${status} (likely a datacenter-IP block) — ` +
        'web search is degraded. Set BRAVE_SEARCH_API_KEY for reliable server-side web search.',
    )
    return []
  }
  if (!body) return []
  if (!body.includes('result__') && !body.includes('result-link')) {
    log.warn(
      '[webSearchEngine] DuckDuckGo response had no result markup (anti-bot challenge). ' +
        'Set BRAVE_SEARCH_API_KEY for reliable server-side web search.',
    )
    return []
  }

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

  if (isLiveSearchDisabledInTests()) {
    return []
  }

  // 1. SearXNG (self-hosted, primary): keyless, unlimited, datacenter-reliable.
  const searxng = getSearxngProvider()
  if (searxng) {
    try {
      const results = await searxng({ query: q, count, timeoutMs })
      if (Array.isArray(results) && results.length) {
        return results
          .filter((r) => r?.url && !shouldSkip(r.url))
          .slice(0, count)
          .map((r) => ({ url: r.url, title: r.title || '', snippet: r.snippet || '' }))
      }
    } catch (err) {
      log.warn(`[webSearchEngine] SearXNG search failed for "${q}": ${err?.message ?? err}`)
    }
  }

  // 2. Brave API (fallback, only when keyed): a metered backstop.
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

  // 3. DuckDuckGo HTML (last resort, no key): dead from cloud IPs, kept for dev.
  try {
    return await duckDuckGoSearch(q, count, timeoutMs)
  } catch (err) {
    log.warn(`[webSearchEngine] DuckDuckGo search failed for "${q}": ${err?.message ?? err}`)
    return []
  }
}

export default { searchWeb }
