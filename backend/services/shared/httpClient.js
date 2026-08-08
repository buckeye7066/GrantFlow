import axios from 'axios'
import { assertSsrfSafeUrl } from '../../config/urlRules.js'

// Axios uses HTTP_PROXY, HTTPS_PROXY, NO_PROXY from the environment. If crawlers fail with
// ENOTFOUND/ETIMEDOUT, check that proxy settings do not block outbound requests.

// ---------------------------------------------------------------------------
// SSRF posture for this module — read before adding a guard anywhere here.
// ---------------------------------------------------------------------------
//
// This client serves TWO populations and they need OPPOSITE treatment:
//
//   1. Hardcoded first-party API hosts (grants.gov, Google CSE) and our OWN
//      internal services — most importantly SearXNG, whose documented default
//      is `SEARXNG_URL=http://127.0.0.1:8080`. A blanket SSRF guard here would
//      classify our own search backend as an attack and blackhole web search.
//   2. Untrusted URLs that came from a crawl, an LLM extraction, or a listing
//      decomposition — `headForVerification` exists precisely to probe these,
//      and Yana's page fetcher reads candidate homepages found via search.
//
// So enforcement is OPT-IN (`options.ssrfSafe`), never global: population (2)
// turns it on at the call site, population (1) is deliberately untouched.
// `headForVerification` is always guarded because probing untrusted URLs is
// its entire purpose.

const SSRF_MAX_REDIRECTS = 5

/**
 * Throw a tagged, non-retryable error when a URL must not be reached.
 * Tagged (rather than a bare Error) so `isRetryableAxiosError` can never
 * mistake a policy refusal for a transient network blip and re-issue it.
 */
async function assertEgressAllowed(url) {
  const verdict = await assertSsrfSafeUrl(url)
  if (!verdict?.ok) {
    const err = new Error(`ssrf_blocked:${verdict?.reason || 'unknown'}`)
    err.code = 'SSRF_BLOCKED'
    err.ssrfBlocked = true
    err.reason = verdict?.reason || 'unknown'
    throw err
  }
}

/**
 * One axios attempt with EVERY redirect hop re-validated.
 *
 * `maxRedirects: 5` is not a guard: axios follows those hops inside
 * follow-redirects, where our async DNS check never runs, so a crawled host
 * answering `302 -> http://169.254.169.254/` reaches cloud metadata even
 * though the first URL was clean. Axios's `beforeRedirect` hook cannot fix
 * this either — it is synchronous and our check must await DNS. Taking manual
 * control is the only way to validate each hop.
 *
 * Returns `{ response, finalUrl }` so callers that report the settled URL
 * (headForVerification) do not need to dig into axios adapter internals.
 */
async function ssrfSafeAxiosRequest(config) {
  let currentUrl = config.url
  for (let hop = 0; hop <= SSRF_MAX_REDIRECTS; hop += 1) {
    await assertEgressAllowed(currentUrl)
    const response = await axios.request({
      ...config,
      url: currentUrl,
      maxRedirects: 0, // we follow them ourselves, re-checking each target
      validateStatus: () => true,
    })
    const isRedirect = response.status >= 300 && response.status < 400
    const location = isRedirect ? response.headers?.location : null
    // A 3xx with no Location is terminal — hand it back rather than loop.
    if (!location) return { response, finalUrl: currentUrl }
    try {
      currentUrl = new URL(location, currentUrl).toString()
    } catch {
      const err = new Error('ssrf_blocked:unparseable_redirect')
      err.code = 'SSRF_BLOCKED'
      err.ssrfBlocked = true
      err.reason = 'unparseable_redirect'
      throw err
    }
  }
  const err = new Error('ssrf_blocked:too_many_redirects')
  err.code = 'SSRF_BLOCKED'
  err.ssrfBlocked = true
  err.reason = 'too_many_redirects'
  throw err
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitter(ms) {
  const spread = Math.max(50, Math.round(ms * 0.2))
  const delta = Math.floor(Math.random() * spread) - Math.floor(spread / 2)
  return Math.max(0, ms + delta)
}

function isRetryableStatus(status) {
  if (!status) return false
  return status === 429 || (status >= 500 && status <= 599)
}

function isRetryableAxiosError(error) {
  // Policy refusals are never transient — retrying just re-issues the same
  // blocked request and muddies the telemetry.
  if (error?.ssrfBlocked || error?.code === 'SSRF_BLOCKED') return false

  const status = error?.response?.status
  if (isRetryableStatus(status)) return true

  const code = error?.code
  // Network/timeout-ish conditions that are usually transient.
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    // code === 'ENOTFOUND' || // DNS resolution failure - usually permanent
    code === 'ECONNABORTED'
  )
}

export async function requestWithRetry(config, options = {}) {
  const {
        retries = 1,
        timeoutMs = 10000,
    baseDelayMs = 600,
    maxDelayMs = 6000,
    userAgent = 'GrantFlow Crawler/1.0 (+contact: support@grantflow.app)',
    // Opt-in per the posture note at the top of this file. Callers fetching a
    // URL that came from a crawl / LLM extraction / search result MUST set it;
    // callers hitting a hardcoded API host or our own internal SearXNG must not.
    ssrfSafe = false,
  } = options

  const mergedConfig = {
    timeout: timeoutMs,
    validateStatus: () => true, // we handle status ourselves
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json, text/html, */*',
      ...(config?.headers || {}),
    },
    ...config,
  }

  const requestUrl = mergedConfig.url || '(unknown)'
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = ssrfSafe
        ? (await ssrfSafeAxiosRequest(mergedConfig)).response
        : await axios.request(mergedConfig)

      // Success responses
      if (response.status >= 200 && response.status < 300) {
        return response
      }

      // Log non-success HTTP statuses with details (critical for diagnosing API failures)
      const bodySnippet = typeof response.data === 'string'
        ? response.data.slice(0, 200)
        : typeof response.data === 'object'
        ? JSON.stringify(response.data).slice(0, 200)
        : '(no body)'
      console.warn(
        `[HttpClient] HTTP ${response.status} from ${requestUrl} (attempt ${attempt + 1}/${retries + 1}): ${bodySnippet}`,
      )

      // Retryable HTTP status
      if (attempt < retries && isRetryableStatus(response.status)) {
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
        await sleep(jitter(delay))
        continue
      }

      const err = new Error(`HTTP ${response.status}`)
      err.status = response.status
      err.response = response
      err.requestUrl = requestUrl
      throw err
    } catch (error) {
      lastError = error
      if (!error.requestUrl) error.requestUrl = requestUrl
      if (attempt < retries && isRetryableAxiosError(error)) {
        const code = error?.code || ''
        console.warn(
          `[HttpClient] Retryable error (${code}) from ${requestUrl} (attempt ${attempt + 1}/${retries + 1}): ${error.message}`,
        )
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
        await sleep(jitter(delay))
        continue
      }
      throw error
    }
  }

  throw lastError ?? new Error(`Request to ${requestUrl} failed after ${retries + 1} attempts`)
}

export async function getWithRetry(url, config = {}, options = {}) {
  return await requestWithRetry({ ...config, method: 'GET', url }, options)
}

export async function postWithRetry(url, data, config = {}, options = {}) {
  return await requestWithRetry({ ...config, method: 'POST', url, data }, options)
}


/**
 * HEAD request for URL verification. Never throws; returns { ok, status }.
 * ok=true when status 200-399.
 *
 * ALWAYS SSRF-guarded: its callers hand it untrusted input —
 * `opportunityInserter` liveness-checks every crawled / LLM-extracted
 * opportunity URL through here (the canonical ingest gate), Yana probes
 * candidate homepages found via search, and the domain corpus crawler probes
 * crawled domains. It previously ran a bare axios HEAD with `maxRedirects: 5`
 * and no validation at all, and it RETURNS both the status and the
 * post-redirect `finalUrl` — so anyone who could get a URL into the catalog
 * had a semi-blind probe of internal ranges and the Railway metadata endpoint.
 *
 * Redirects are followed manually so every hop is re-validated. Self-contained
 * (uses assertSsrfSafeUrl + axios maxRedirects:0) so this can land without
 * depending on the still-open safeFetch chokepoint PR.
 *
 * @returns {Promise<{ok: boolean, status: number|null, finalUrl: string|null,
 *                     blocked: boolean, reason?: string, error?: string}>}
 */
export async function headForVerification(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  try {
    const { response, finalUrl } = await ssrfSafeAxiosRequest({
      method: 'HEAD',
      url,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'GrantFlow Crawler/1.0 (+contact: support@grantflow.app)',
      },
    })
    const ok = response.status >= 200 && response.status < 400
    return { ok, status: response.status, finalUrl, blocked: false }
  } catch (err) {
    if (err?.ssrfBlocked || err?.code === 'SSRF_BLOCKED') {
      // `ok:false` is correct — a URL resolving to internal space must never be
      // admitted to the catalog. But it is reported as BLOCKED, not as a dead
      // link: "we refused to look" and "we looked and it was dead" are
      // different facts, and only the second is evidence about the funder.
      return {
        ok: false,
        status: null,
        error: err.message,
        finalUrl: null,
        blocked: true,
        reason: err.reason,
      }
    }
    return {
      ok: false,
      status: null,
      error: err?.message || String(err),
      finalUrl: null,
      blocked: false,
    }
  }
}
