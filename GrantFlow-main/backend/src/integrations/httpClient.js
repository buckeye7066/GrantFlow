/**
 * Production-grade HTTP client wrapper for external Funding APIs.
 *
 * Requirements:
 * - Standard headers + User-Agent: "GrantFlow (Axiom BioLabs)"
 * - Retries/backoff with special handling for 429 and timeouts
 * - Never logs secrets
 */

import axios from 'axios'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_BACKOFF_MS = 400

export const GRANTFLOW_USER_AGENT = 'GrantFlow (Axiom BioLabs)'

/**
 * @typedef {Object} HttpRequestOptions
 * @property {string} url
 * @property {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'=} method
 * @property {Record<string, string>=} headers
 * @property {Record<string, any>=} params
 * @property {any=} data
 * @property {number=} timeoutMs
 * @property {number=} maxRetries
 * @property {string=} provider - label for logs/errors only (no secrets)
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitter(ms) {
  const spread = Math.max(50, Math.round(ms * 0.2))
  const delta = Math.floor(Math.random() * spread)
  return ms + delta
}

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) return null
  const raw = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader
  const s = String(raw).trim()
  if (!s) return null

  // Retry-After can be seconds or an HTTP date.
  const seconds = Number(s)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))

  const dateMs = Date.parse(s)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return null
}

/**
 * @param {any} err
 * @returns {{ status: number|null, code: string|null, message: string }}
 */
function summarizeAxiosError(err) {
  const status = err?.response?.status != null ? Number(err.response.status) : null
  const code = typeof err?.code === 'string' ? err.code : null
  const message = typeof err?.message === 'string' ? err.message : String(err)
  return { status, code, message }
}

/**
 * Request JSON with retries/backoff.
 * Returns parsed JSON (axios `response.data`).
 *
 * @template T
 * @param {HttpRequestOptions} options
 * @returns {Promise<T>}
 */
export async function requestJson(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    params = {},
    data = undefined,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    provider = 'external',
  } = options || {}

  if (!url) throw new Error('requestJson: url is required')

  /** @type {import('axios').AxiosRequestConfig} */
  const config = {
    url,
    method,
    params,
    data,
    timeout: timeoutMs,
    headers: {
      Accept: 'application/json',
      'User-Agent': GRANTFLOW_USER_AGENT,
      ...headers,
    },
    // axios throws on non-2xx; keep it that way so retry policy can run.
    validateStatus: () => true,
  }

  let lastErr = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const isLast = attempt === maxRetries
    try {
      const res = await axios(config)
      const status = Number(res.status)

      if (status >= 200 && status < 300) {
        return /** @type {any} */ (res.data)
      }

      // Rate limit handling
      if (status === 429) {
        if (isLast) {
          throw new Error(`[${provider}] HTTP 429 Too Many Requests (max retries exceeded)`)
        }

        const retryAfterMs = parseRetryAfterMs(res.headers?.['retry-after'])
        const waitMs = retryAfterMs ?? jitter(DEFAULT_BASE_BACKOFF_MS * Math.pow(2, attempt))
        await sleep(waitMs)
        continue
      }

      // Retry on transient server errors
      if ([500, 502, 503, 504].includes(status)) {
        if (isLast) {
          throw new Error(`[${provider}] HTTP ${status} (max retries exceeded)`)
        }
        const waitMs = jitter(DEFAULT_BASE_BACKOFF_MS * Math.pow(2, attempt))
        await sleep(waitMs)
        continue
      }

      // Non-retryable status
      const bodyHint =
        res?.data && typeof res.data === 'object'
          ? JSON.stringify(res.data).slice(0, 400)
          : typeof res?.data === 'string'
            ? res.data.slice(0, 400)
            : ''
      throw new Error(
        `[${provider}] HTTP ${status} ${method} ${url}${bodyHint ? ` :: ${bodyHint}` : ''}`,
      )
    } catch (err) {
      lastErr = err
      const { status, code } = summarizeAxiosError(err)

      // axios timeout / network errors
      const isTimeout = code === 'ECONNABORTED'
      const isNetwork = status == null

      if (isLast) break

      if (isTimeout || isNetwork) {
        const waitMs = jitter(DEFAULT_BASE_BACKOFF_MS * Math.pow(2, attempt))
        await sleep(waitMs)
        continue
      }

      // If we got here, it was a non-retryable error thrown above; stop early.
      break
    }
  }

  const { status, code, message } = summarizeAxiosError(lastErr)
  const suffix = status != null ? ` status=${status}` : code ? ` code=${code}` : ''
  throw new Error(`[${provider}] request failed${suffix}: ${message}`)
}

