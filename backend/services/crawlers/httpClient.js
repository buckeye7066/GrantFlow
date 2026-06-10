import axios from 'axios'

// Axios uses HTTP_PROXY, HTTPS_PROXY, NO_PROXY from the environment. If crawlers fail with
// ENOTFOUND/ETIMEDOUT, check that proxy settings do not block outbound requests.

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
      const response = await axios.request(mergedConfig)

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
 */
export async function headForVerification(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  try {
    const response = await axios.request({
      method: 'HEAD',
      url,
      timeout: timeoutMs,
      validateStatus: () => true,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'GrantFlow Crawler/1.0 (+contact: support@grantflow.app)',
      },
    })
    const ok = response.status >= 200 && response.status < 400
    // axios surfaces the final URL after redirects on response.request.res.responseUrl
    // (Node adapter) or response.request.responseURL (browser/xhr adapter).
    const finalUrl =
      response?.request?.res?.responseUrl ||
      response?.request?.responseURL ||
      response?.config?.url ||
      url
    return { ok, status: response.status, finalUrl }
  } catch (err) {
    return { ok: false, status: null, error: err?.message || String(err), finalUrl: null }
  }
}
