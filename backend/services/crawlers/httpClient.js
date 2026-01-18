import axios from 'axios'

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
    code === 'ENOTFOUND' ||
    code === 'ECONNABORTED'
  )
}

export async function requestWithRetry(config, options = {}) {
  const {
    retries = 2,
    timeoutMs = 15000,
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

  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.request(mergedConfig)

      // Success responses
      if (response.status >= 200 && response.status < 300) {
        return response
      }

      // Retryable HTTP status
      if (attempt < retries && isRetryableStatus(response.status)) {
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
        await sleep(jitter(delay))
        continue
      }

      const err = new Error(`HTTP ${response.status}`)
      err.status = response.status
      err.response = response
      throw err
    } catch (error) {
      lastError = error
      if (attempt < retries && isRetryableAxiosError(error)) {
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
        await sleep(jitter(delay))
        continue
      }
      throw error
    }
  }

  throw lastError ?? new Error('request failed')
}

export async function getWithRetry(url, config = {}, options = {}) {
  return await requestWithRetry({ ...config, method: 'GET', url }, options)
}

export async function postWithRetry(url, data, config = {}, options = {}) {
  return await requestWithRetry({ ...config, method: 'POST', url, data }, options)
}

