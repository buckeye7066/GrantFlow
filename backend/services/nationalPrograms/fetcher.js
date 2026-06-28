import fetch from 'node-fetch'
import { createLogger } from '../../utils/logger.js'
const qualityLog = createLogger('services:nationalPrograms:fetcher')

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
    return new Promise((resolve, reject) => {
      state.queue.push({ url, options, resolve, reject })
      this._pump(host).catch((err) => {
        qualityLog.error(`[RateLimitedFetcher] Pump error for ${host}:`, err)
        // Do NOT resolve here â the task itself carries resolve/reject.
        // A pump-level crash that was not tied to a specific task is just logged.
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
        .catch((err) => {
          if (typeof task.reject === 'function') {
            task.reject(err)
          } else {
            task.resolve({ ok: false, status: 0, error: err })
          }
        })
        .finally(() => {
          state.inFlight -= 1
          this._pump(host).catch(e => {
            qualityLog.error('[RateLimitedFetcher] Background pump error for host ' + host + ':', e)
            // Drain remaining queued tasks so callers are not left hanging
            const st = this._state(host)
            while (st.queue.length > 0) {
              const t = st.queue.shift()
              t.resolve({ ok: false, error: e })
            }
          })
        })
    }
  }

  async _runTask(state, task) {
    const { url, options } = task
    const now = Date.now()
    const wait = Math.max(0, state.lastAt + this.perHostMinDelayMs - now)
    // Update lastAt immediately (before awaiting) so concurrent tasks
    // from the same host stagger themselves correctly.
    state.lastAt = now + wait
    if (wait > 0) await sleep(wait)

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
    if (!err.code) {
      if (err.name === 'AbortError') {
        err.code = 'TIMEOUT'
      } else if (err.message?.includes('ENOTFOUND')) {
        err.code = 'DNS_LOOKUP_FAILED'
      } else {
        err.code = 'FETCH_FAILED'
      }
    }
    throw err
  }
}

