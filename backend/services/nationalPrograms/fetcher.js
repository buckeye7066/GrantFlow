import fetch from 'node-fetch'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export class RateLimitedFetcher {
  constructor({
    userAgent = 'GrantFlowNationalProgramsCrawler/1.0 (+https://grantflow.app)',
    perHostConcurrency = 2,
    perHostMinDelayMs = 800,
    timeoutMs = 20000,
    maxRetries = 2,
  } = {}) {
    this.userAgent = userAgent
    this.perHostConcurrency = perHostConcurrency
    this.perHostMinDelayMs = perHostMinDelayMs
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.hostStates = new Map()
  }

  _state(host) {
    if (!this.hostStates.has(host)) {
      this.hostStates.set(host, { inFlight: 0, lastAt: 0, queue: [] })
    }
    return this.hostStates.get(host)
  }

  async fetch(url, options = {}) {
    const host = hostOf(url) ?? 'unknown'
    const state = this._state(host)
    return new Promise((resolve) => {
      state.queue.push({ url, options, resolve })
      this._pump(host).catch(() => {
        // no-op; individual task resolves to error response
      })
    })
  }

  async _pump(host) {
    const state = this._state(host)
    while (state.inFlight < this.perHostConcurrency && state.queue.length > 0) {
      const task = state.queue.shift()
      state.inFlight += 1
      this._runTask(state, task)
        .then(task.resolve)
        .catch((err) => task.resolve({ ok: false, error: err }))
        .finally(() => {
          state.inFlight -= 1
          this._pump(host).catch(e => console.warn('[background]', e?.message || e))
        })
    }
  }

  async _runTask(state, task) {
    const { url, options } = task
    const now = Date.now()
    const wait = Math.max(0, state.lastAt + this.perHostMinDelayMs - now)
    if (wait > 0) await sleep(wait)
    state.lastAt = Date.now()

    const headers = {
      'user-agent': this.userAgent,
      ...(options.headers || {}),
    }

    let lastError = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs)
      try {
        const response = await fetch(url, {
          method: options.method ?? 'GET',
          headers,
          redirect: 'follow',
          signal: controller.signal,
        })
        clearTimeout(timeout)
        return response
      } catch (error) {
        clearTimeout(timeout)
        lastError = error
        const backoff = 250 * Math.pow(2, attempt)
        await sleep(backoff)
      }
    }

    const err = lastError instanceof Error ? lastError : new Error(String(lastError))
    err.code = err.code || 'FETCH_FAILED'
    throw err
  }
}

