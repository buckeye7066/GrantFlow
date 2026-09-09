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

// Allow unit tests to mock outbound HTTP without patching module loaders.
// This is intentionally not exported as part of the public app API surface.
let axiosClient = axios

export function __setAxiosForTests(mockImpl) {
  axiosClient = mockImpl
}

export function __resetAxiosForTests() {
  axiosClient = axios
}

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
  const status =
    err?.response?.status !== null && err?.response?.status !== undefined
      ? Number(err.response.status)
      : null
  const code = typeof err?.code === 'string' ? err.code : null
  const message = typeof err?.message === 'string' ? err.message : String(err)
  return { status, code, message }
}

/** Keep protocol evidence separate from the loggable error message. */
function responseError(message, response) {
  const error = new Error(message)
  // Do not retain Axios config/request headers or serialize upstream payloads.
  Object.defineProperty(error, 'response', {
    value: { status: Number(response.status), data: response.data },
  })
  return error
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
    // Inspect every HTTP response here; transport failures still throw.
    validateStatus: () => true,
  }

  let lastErr = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const isLast = attempt === maxRetries
    try {
      const res = await axiosClient(config)
      const status = Number(res.status)

      if (status >= 200 && status < 300) {
        return /** @type {any} */ (res.data)
      }

      // Rate limit handling
      if (status === 429) {
        if (isLast) {
          throw responseError(`[${provider}] HTTP 429 Too Many Requests (max retries exceeded)`, res)
        }

        const retryAfterMs = parseRetryAfterMs(res.headers?.['retry-after'])
        const waitMs = retryAfterMs ?? jitter(DEFAULT_BASE_BACKOFF_MS * Math.pow(2, attempt))
        await sleep(waitMs)
        continue
      }

      // Retry on transient server errors
      if ([500, 502, 503, 504].includes(status)) {
        if (isLast) {
          throw responseError(`[${provider}] HTTP ${status} (max retries exceeded)`, res)
        }
        const waitMs = jitter(DEFAULT_BASE_BACKOFF_MS * Math.pow(2, attempt))
        await sleep(waitMs)
        continue
      }

      // A real HTTP rejection is not a missing-response network failure.
      // Keep its structured body for provider-specific protocol handling, not logs.
      throw responseError(`[${provider}] HTTP ${status} ${method} ${url}`, res)
    } catch (err) {
      lastErr = err
      const { status, code } = summarizeAxiosError(err)

      // axios timeout / network errors
      const isTimeout = code === 'ECONNABORTED'
      const isNetwork = (status === null || status === undefined)

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
  const suffix = (status !== null && status !== undefined) ? ` status=${status}` : code ? ` code=${code}` : ''
  const failure = lastErr?.response
    ? responseError(`[${provider}] request failed${suffix}: ${message}`, lastErr.response)
    : new Error(`[${provider}] request failed${suffix}: ${message}`)
  if (code) failure.code = code
  throw failure
}

