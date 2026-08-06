/**
 * Shared live web-search engine.
 *
 * One `searchWeb(query)` entry point that returns normalized
 * `[{ url, title, snippet }]` results. The returned array also carries a
 * non-enumerable `searchMeta` provenance object, so measurement callers can
 * distinguish cache/live/empty/unavailable outcomes without changing the
 * long-standing result-array contract. Provider chain, in order:
 *
 *   0. Google CSE (official Custom Search JSON API, TOP RUNG when keyed) —
 *      the "basic google search" (owner 2026-08-04). Daily-budget-gated
 *      (googleBudget.js) and quota-degraded to the next UTC midnight on
 *      403/429; unconfigured/exhausted, it silently yields to the ladder.
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
import { makeGoogleCseProvider } from './googleCseProvider.js'
import { tryConsumeGoogleQuery } from './googleBudget.js'
import { distinctiveTerms, coveredTerms } from './queryRelevance.js'
import { getCachedSearch, putCachedSearch } from './webSearchCache.js'
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
// Google CSE (official API) sits ABOVE SearXNG: the "basic google search"
// rung (owner directive 2026-08-04). Budget-gated (googleBudget.js, daily
// quota) and quota-degraded until the next UTC midnight on a 403/429, so an
// unconfigured or exhausted key silently yields to the rest of the ladder.
let _google = null
let _googleResolved = false
let _googleDegradedUntil = 0
function getGoogleProvider() {
  if (_googleResolved) return _google
  _googleResolved = true
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) {
    try {
      _google = makeGoogleCseProvider({ count: 8 })
      log.info('[webSearchEngine] Google CSE search provider active (top rung)')
    } catch (err) {
      log.warn(`[webSearchEngine] Google CSE provider unavailable: ${err?.message ?? err}`)
      _google = null
    }
  }
  return _google
}

function nextUtcMidnight(now = Date.now()) {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

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

// DuckDuckGo is DEAD from datacenter/cloud IPs (202 anti-bot challenge). Once we
// observe the block in this process, stop paying the per-query network timeout:
// every subsequent DDG query short-circuits to [] until the process restarts (or
// a test reset). Without this, a discovery run with no SearXNG/Brave provider
// pays the full DDG timeout on EVERY web query in sequence (~8s×N), which starves
// the gateway-safe crawl budget and makes /run-smart return an empty partial.
// ponytail: process-lifetime breaker (no TTL) — a restart re-probes; that's the
// upgrade path if a datacenter IP ever becomes un-blocked.
let _ddgBlocked = false

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

// ── Cross-query identity breaker (the collapse's unfakeable signature) ──────
// A degraded SearXNG returns the IDENTICAL result set for DIFFERENT queries
// (its surviving scraped engine answers only the leading token, so every
// "<School X> …" query gets the same 8 links). Two genuinely different queries
// never share an identical top-8, so exact-set identity across distinct query
// strings is mechanical proof of instance degradation — no relevance heuristic
// involved. While tripped, the default engine set is skipped in favor of the
// fallback allowlist; the TTL re-probes so a recovered instance is readopted.
const SEARXNG_DEGRADED_TTL_MS = 10 * 60 * 1000
const RECENT_SERP_CAP = 20
let _recentSerps = [] // [{ q, key }]
let _searxngDegradedUntil = 0

function serpIdentityKey(results) {
  return results.map((r) => String(r?.url ?? '')).sort().join('|')
}

/** Record a default-engine SERP; returns true when it proves degradation. */
function tripsCrossQueryIdentity(q, results) {
  if (!Array.isArray(results) || results.length < 3) return false
  const key = serpIdentityKey(results)
  const clash = _recentSerps.find((e) => e.key === key && e.q !== q)
  if (!_recentSerps.some((e) => e.q === q && e.key === key)) {
    _recentSerps.push({ q, key })
    if (_recentSerps.length > RECENT_SERP_CAP) _recentSerps.shift()
  }
  return Boolean(clash)
}

/** Reset cached provider state — test seam only. */
export function _resetWebSearchEngineForTests() {
  _google = null
  _googleResolved = false
  _googleDegradedUntil = 0
  _searxng = null
  _searxngResolved = false
  _brave = null
  _braveResolved = false
  _ddgBlocked = false
  _recentSerps = []
  _searxngDegradedUntil = 0
}

function withSearchMeta(results, meta = {}) {
  const out = Array.isArray(results) ? results : []
  Object.defineProperty(out, 'searchMeta', {
    value: Object.freeze({
      provider: String(meta.provider || 'unknown'),
      provenance: String(meta.provenance || 'unknown'),
      status: String(meta.status || (out.length ? 'ok' : 'empty')),
      cache_age_ms: meta.cache_age_ms ?? null,
      cache_age_available: meta.cache_age_ms !== null && meta.cache_age_ms !== undefined,
      provider_mode: meta.provider_mode ?? null,
      cache_write_succeeded: meta.cache_write_succeeded ?? null,
      reason: meta.reason ?? null,
    }),
    enumerable: false,
    configurable: true,
  })
  return out
}

function shouldSkip(url) {
  const u = String(url || '').toLowerCase()
  if (!/^https?:\/\//.test(u)) return true
  return SKIP_SUBSTRINGS.some((s) => u.includes(s))
}

// Tokens too common to prove a result is ABOUT the query. Deliberately small:
// the gate below only needs to tell "results about the whole query" from
// "results about its first word", not to rank relevance.
// Tokenizer + coverage rule live in ./queryRelevance.js so this per-SERP gate
// and searxngProvider's per-result ranking can never disagree about the same
// SERP. Do not re-inline them here.

/**
 * looksDegenerateSerp — does this result set answer only the query's FIRST
 * word?
 *
 * THE FAILURE THIS CATCHES (prod, found 2026-07-27): the self-hosted SearXNG's
 * engine fleet collapsed — brave/google-cse/qwant/startpage/wikipedia all
 * suspended (datacenter-IP rate limits / CAPTCHAs) — leaving only the scraped
 * bing engine, which degrades to a generic SERP for the query's leading token.
 * "Cleveland State Community College scholarships" returned Cleveland-Ohio
 * TOURISM pages on every call. The provider chain saw a non-empty result set
 * and never consulted Brave, so every multi-word discovery query fleet-wide
 * got junk: Amy's student cohort missed institution recall 6/6 (the
 * institution_recall_miss ×12 class), and web-lane runs extracted 0.
 *
 * The test: a SERP is healthy only if at least ONE result covers a real
 * MAJORITY (>= 60%) of the query's distinctive terms. "Any result matches any
 * non-leading term" was tried first and under-fired on the live junk —
 * Wikipedia's Cleveland-the-city snippet says "state of Ohio", so the single
 * quasi-generic word "state" cleared the whole tourism SERP (verified live
 * 2026-07-27). A genuinely on-topic result names most of the query's terms; a
 * first-word SERP tops out around half. One passing result clears the set, so
 * a healthy-but-mediocre SERP is never rejected; single-distinctive-term
 * queries can never be degenerate (nothing to cover beyond that term). A
 * wrong "degenerate" verdict costs one budget-metered Brave call and keeps
 * the held set as fallback — results are rerouted, never lost.
 *
 * Pure; exported for tests.
 */
export function looksDegenerateSerp(query, results) {
  if (!Array.isArray(results) || results.length === 0) return false
  const terms = distinctiveTerms(query)
  if (terms.length < 2) return false
  const needed = Math.ceil(terms.length * 0.6)
  // WHOLE-WORD matching (in coveredTerms): substring matching let 'western
  // United States' count as covering the term 'west' (the
  // University-of-West-Florida junk SERP slipped through on it, verified live
  // 2026-07-27).
  return !results.some((r) => coveredTerms(r, terms).length >= needed)
}

/**
 * looksEngineCollapse — is this SERP the product of a collapsed engine fleet?
 *
 * The searxngProvider attaches per-response telemetry (non-enumerable
 * `searxngMeta`): which engines actually produced results and which the
 * instance reports as unresponsive/suspended. When results come ONLY from
 * scraped bing while 2+ other engines sit suspended (the 2026-07-28 state:
 * brave + google-cse "too many requests", startpage/qwant CAPTCHA), the SERP
 * may still LOOK topical enough to clear looksDegenerateSerp (bing covers a
 * couple of the query's words with shopping/aggregator junk) — but recall
 * quality is gone. Mechanical, no relevance heuristic: pure engine telemetry.
 *
 * Pure; exported for tests.
 */
export function looksEngineCollapse(meta) {
  if (!meta || typeof meta !== 'object') return false
  const engines = Array.isArray(meta.result_engines) ? meta.result_engines : []
  const unresponsive = Array.isArray(meta.unresponsive_engines) ? meta.unresponsive_engines : []
  return engines.length > 0 && engines.every((e) => e === 'bing') && unresponsive.length >= 2
}

async function duckDuckGoSearch(query, count, timeoutMs) {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await getWithRetry(
    searchUrl,
    { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.5' } },
    // retries:0 — a blocked datacenter IP is a stable fact, not a transient
    // error, so a retry just doubles the wasted per-query timeout. The
    // process-level breaker (below) short-circuits every query after the first.
    { timeoutMs, retries: 0 },
  )
  // DuckDuckGo serves a 202 anti-bot challenge (no result markup) to datacenter
  // / cloud IPs — exactly where this runs in prod. Detect it and warn ONCE-style
  // so "0 web results" is diagnosable as a blocked backend, not a silent miss.
  // The reliable server-side web backend is Brave (set BRAVE_SEARCH_API_KEY).
  const status = Number(response?.status)
  const body = String(response?.data || '')
  if (status && status !== 200) {
    _ddgBlocked = true
    log.warn(
      `[webSearchEngine] DuckDuckGo returned HTTP ${status} (likely a datacenter-IP block) — ` +
        'disabling DuckDuckGo for this process. Set BRAVE_SEARCH_API_KEY or SEARXNG_URL for reliable server-side web search.',
    )
    return []
  }
  if (!body) return []
  if (!body.includes('result__') && !body.includes('result-link')) {
    _ddgBlocked = true
    log.warn(
      '[webSearchEngine] DuckDuckGo response had no result markup (anti-bot challenge) — ' +
        'disabling DuckDuckGo for this process. Set BRAVE_SEARCH_API_KEY or SEARXNG_URL for reliable server-side web search.',
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
  if (!q) return withSearchMeta([], { provider: 'none', provenance: 'none', status: 'not_attempted', reason: 'empty_query' })

  if (isLiveSearchDisabledInTests()) {
    return withSearchMeta([], { provider: 'none', provenance: 'none', status: 'not_attempted', reason: 'live_search_disabled_in_tests' })
  }

  // 0. Persistent SERP cache: nightly fan-outs repeat many queries verbatim
  // (archetype queries recur night over night; golden profiles even share
  // queries within one run), and that repeated volume is what suspends the
  // upstream engines. A query answered within the TTL never re-hits an
  // engine. Only HEALTHY sets are ever cached (below), so junk from a bad
  // night cannot be replayed. Best-effort: no DB → plain miss.
  const cached = await getCachedSearch(q, { count })
  if (cached) {
    // webSearchCache's current contract does not return created_at, so age is
    // explicitly unknown rather than guessed from the configured TTL.
    return withSearchMeta(cached, {
      provider: 'cache',
      provenance: 'cache',
      status: 'ok',
      cache_age_ms: null,
      reason: 'cache_age_not_exposed_by_cache_contract',
    })
  }
  const cacheAndReturn = async (results, meta) => {
    const cacheWriteSucceeded = await putCachedSearch(q, results)
    return withSearchMeta(results, { ...meta, cache_write_succeeded: cacheWriteSucceeded === true })
  }

  // 0.5. Google CSE (official API, top rung — the "basic google search" the
  // owner asked for, 2026-08-04). A cache hit above never spends budget; a
  // budget refusal or quota degradation silently yields to SearXNG, so this
  // rung can only ADD result quality, never cost the ladder a query. An EMPTY
  // Google answer also falls through — a site-restricted CX or thin SERP must
  // not become the cached answer for the day.
  const google = getGoogleProvider()
  if (google && Date.now() >= _googleDegradedUntil) {
    const budget = await tryConsumeGoogleQuery({})
    if (budget.allowed) {
      try {
        const results = await google({ query: q, count, timeoutMs })
        if (Array.isArray(results) && results.length) {
          const cleaned = results
            .filter((r) => r?.url && !shouldSkip(r.url))
            .slice(0, count)
            .map((r) => ({ url: r.url, title: r.title || '', snippet: r.snippet || '' }))
          if (cleaned.length) {
            return cacheAndReturn(cleaned, {
              provider: 'google_cse',
              provenance: 'live',
              status: 'ok',
              provider_mode: 'official_api',
            })
          }
        }
      } catch (err) {
        if (err?.code === 'google_quota') {
          _googleDegradedUntil = nextUtcMidnight()
          log.warn(`[webSearchEngine] Google CSE quota refused — skipping the Google rung until the UTC reset (${new Date(_googleDegradedUntil).toISOString()})`)
        } else {
          log.warn(`[webSearchEngine] Google CSE search failed for "${q}": ${err?.message ?? err}`)
        }
      }
    }
  }

  // 1. SearXNG (self-hosted, primary): keyless, unlimited, datacenter-reliable.
  // A non-empty result set is NOT proof the backend is healthy: when its engine
  // fleet collapses to scraped-bing, it returns a generic SERP for the query's
  // first word (see looksDegenerateSerp). Those junk sets are HELD rather than
  // returned, the fallbacks get the query, and the held set is the last-resort
  // return so a misfiring heuristic can never make results worse than before.
  let heldDegenerate = null
  const searxng = getSearxngProvider()
  const searxngClean = async (engines) => {
    const results = await searxng({ query: q, count, timeoutMs, ...(engines !== undefined ? { engines } : {}) })
    if (!Array.isArray(results) || !results.length) return null
    const cleaned = results
      .filter((r) => r?.url && !shouldSkip(r.url))
      .slice(0, count)
      .map((r) => ({ url: r.url, title: r.title || '', snippet: r.snippet || '' }))
    if (!cleaned.length) return null
    // Carry the provider's engine-health telemetry through the cleanup (it is
    // non-enumerable, so the [{url,title,snippet}] contract is unchanged).
    if (results.searxngMeta) {
      Object.defineProperty(cleaned, 'searxngMeta', { value: results.searxngMeta, enumerable: false })
    }
    return cleaned
  }
  const degradedActive = Date.now() < _searxngDegradedUntil
  // The default engine set answering EMPTY is its own failure mode: every
  // engine suspended at once returns zero results (observed live 2026-07-27),
  // which is neither degenerate nor an error — and with Brave budget-paused
  // the old chain returned [] without ever asking the fallback engines.
  let defaultCameUpEmpty = false
  if (searxng && !degradedActive) {
    try {
      const cleaned = await searxngClean(undefined)
      if (cleaned) {
        // The cross-query identity breaker outranks the relevance gate: an
        // identical set for a DIFFERENT query is proof of degradation even
        // when the junk happens to share words with this query (the
        // Montana-tourism SERP covered "montana"+"state" and read on-topic).
        if (tripsCrossQueryIdentity(q, cleaned)) {
          _searxngDegradedUntil = Date.now() + SEARXNG_DEGRADED_TTL_MS
          heldDegenerate = cleaned
          log.warn(`[webSearchEngine] SearXNG served an IDENTICAL result set for different queries (instance degraded) — preferring fallback engines for ${Math.round(SEARXNG_DEGRADED_TTL_MS / 60000)}m`)
        } else if (looksEngineCollapse(cleaned.searxngMeta)) {
          // Engine telemetry outranks the relevance gate in the OTHER
          // direction too: a bing-only SERP produced while the rest of the
          // fleet sits suspended is degraded even when it happens to cover
          // enough query words to read topical (the 2026-07-28
          // wheelchair-van-grants → shopping-junk class). Held, never lost.
          heldDegenerate = cleaned
          const suspended = (cleaned.searxngMeta.unresponsive_engines || []).map((u) => `${u.engine}:${u.reason || 'unresponsive'}`).join(', ')
          log.warn(`[webSearchEngine] SearXNG engine fleet collapsed to bing-only for "${q}" (suspended: ${suspended}) — trying fallback engines`)
        } else if (!looksDegenerateSerp(q, cleaned)) {
          return cacheAndReturn(cleaned, {
            provider: 'searxng',
            provenance: 'live',
            status: 'ok',
            provider_mode: 'default_engines',
          })
        } else {
          heldDegenerate = cleaned
          log.warn(`[webSearchEngine] SearXNG returned a degenerate first-word SERP for "${q}" — trying fallback engines`)
        }
      } else {
        defaultCameUpEmpty = true
      }
    } catch (err) {
      // A transport-level throw means the INSTANCE is unreachable — the
      // fallback rung would hit the same dead endpoint, so it is not
      // triggered on this branch (Brave/DDG still run below).
      log.warn(`[webSearchEngine] SearXNG search failed for "${q}": ${err?.message ?? err}`)
    }
  }

  // 1b. SAME SearXNG instance, known-good engine allowlist — after the default
  // set answered with junk OR nothing at all, or straight away while the
  // degraded-instance breaker is active. On 2026-07-27 every scraping engine
  // on the instance was suspended (datacenter-IP rate limits/CAPTCHAs) except
  // a broken bing — but `engines=yahoo` still answered "Cleveland State
  // Community College scholarships" with the college's own scholarship pages.
  // Keyless, so this rung costs nothing; a healthy default set never pays the
  // second call.
  if (searxng && (heldDegenerate || degradedActive || defaultCameUpEmpty)) {
    // Multiple engines, ONE call — SearXNG merges them, so whichever of the
    // three is currently un-suspended contributes. Default roster re-measured
    // live 2026-07-28 (5-engine probe against the prod instance): yandex 14
    // results, seznam 10, yahoo 7 — all clean — while mojeek answered
    // "Suspended: access denied" (it hard-blocks datacenter IPs; keeping it
    // here only spent a dead call). Re-measure before editing this default.
    const fallbackEngines = String(process.env.SEARXNG_FALLBACK_ENGINES ?? 'yandex,seznam,yahoo').trim()
    if (fallbackEngines) {
      try {
        const cleaned = await searxngClean(fallbackEngines)
        if (cleaned && !looksDegenerateSerp(q, cleaned)) {
          return cacheAndReturn(cleaned, {
            provider: 'searxng',
            provenance: 'live',
            status: 'ok',
            provider_mode: 'fallback_engines',
          })
        }
        if (cleaned && !heldDegenerate) heldDegenerate = cleaned
      } catch (err) {
        log.warn(`[webSearchEngine] SearXNG fallback-engines search failed for "${q}": ${err?.message ?? err}`)
      }
    }
  }

  // 2. Brave API (fallback, only when keyed): a metered backstop with its own
  // budget breaker — a paused/exhausted key returns [] and costs nothing here.
  const brave = getBraveProvider()
  if (brave) {
    try {
      const results = await brave({ query: q })
      if (Array.isArray(results) && results.length) {
        const cleaned = results
          .filter((r) => r?.url && !shouldSkip(r.url))
          .slice(0, count)
          .map((r) => ({ url: r.url, title: r.title || '', snippet: r.snippet || '' }))
        if (cleaned.length) {
          return cacheAndReturn(cleaned, {
            provider: 'brave',
            provenance: 'live',
            status: 'ok',
            provider_mode: 'api_fallback',
          })
        }
        return withSearchMeta(cleaned, {
          provider: 'brave',
          provenance: 'live',
          status: 'empty',
          provider_mode: 'api_fallback',
        })
      }
    } catch (err) {
      log.warn(`[webSearchEngine] Brave search failed for "${q}": ${err?.message ?? err}`)
    }
  }

  // Brave could not improve on a held degenerate set — return it unchanged
  // (status quo ante: the gate must never LOSE results, only reroute).
  if (heldDegenerate) {
    return withSearchMeta(heldDegenerate, {
      provider: 'searxng',
      provenance: 'live',
      status: 'degraded_results',
      provider_mode: 'held_degenerate',
    })
  }

  // 3. DuckDuckGo HTML (last resort, no key): dead from cloud IPs, kept for dev.
  // Once the block is observed once, every later query no-ops instantly so a
  // full discovery run never burns its budget re-probing a dead backend.
  if (_ddgBlocked) {
    return withSearchMeta([], {
      provider: 'duckduckgo',
      provenance: 'live',
      status: 'unavailable',
      provider_mode: 'html_fallback',
      reason: 'process_breaker_open',
    })
  }
  try {
    const results = await duckDuckGoSearch(q, count, timeoutMs)
    return withSearchMeta(results, {
      provider: 'duckduckgo',
      provenance: 'live',
      status: results.length ? 'ok' : (_ddgBlocked ? 'unavailable' : 'empty'),
      provider_mode: 'html_fallback',
      reason: _ddgBlocked ? 'provider_blocked' : null,
    })
  } catch (err) {
    // A THROW here (almost always a timeout from a datacenter IP that DDG never
    // answers) is the block manifesting as a hang instead of a 202. Trip the
    // breaker so the rest of the run's queries don't each pay the full timeout —
    // this is what collapses ~N×8s of dead time down to a single probe. DDG is
    // the last-resort backend; losing it for the process on one failure is the
    // right trade vs. starving the gateway-safe crawl budget. A restart re-probes.
    _ddgBlocked = true
    log.warn(`[webSearchEngine] DuckDuckGo search failed for "${q}" (${err?.message ?? err}) — disabling DuckDuckGo for this process. Set BRAVE_SEARCH_API_KEY or SEARXNG_URL for reliable server-side web search.`)
    return withSearchMeta([], {
      provider: 'duckduckgo',
      provenance: 'live',
      status: 'unavailable',
      provider_mode: 'html_fallback',
      reason: 'request_failed',
    })
  }
}

export default { searchWeb }
