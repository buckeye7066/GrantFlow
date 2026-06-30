// backend/utils/llmTimeout.js
//
// One shared, gateway-safe deadline for LLM/AI work. The binding constraint is
// the same one realCrawlers.js already documents: Vercel proxies /api/* to
// Railway and drops a proxied response at ~30s (504). An unbounded LLM call (or
// a sequential OpenAI->Anthropic fallback whose timeouts SUM past 30s) blows
// through that, surfacing as a hard 504 with no body — the "Assist with AI hangs"
// symptom — and, inside crawler jobs, blocks the worker's heartbeat long enough
// to be marked "presumed dead" (a chunk of the orphaned-job failures).
//
// withLLMTimeout races an in-flight LLM promise against a deadline and REJECTS
// with a tagged timeout error if the deadline wins (the in-flight call is
// abandoned — its eventual settlement is ignored). Callers catch err.isTimeout
// and return a clean 503 "try again" instead of a 504. Default 26s leaves ~4s
// headroom under the gateway cap for serialization, matching CRAWL_TOTAL_BUDGET_MS.

export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 26000

export class LLMTimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms (gateway deadline)`)
    this.name = 'LLMTimeoutError'
    this.code = 'LLM_TIMEOUT'
    this.isTimeout = true
  }
}

/**
 * Race an LLM promise (or a thunk returning one) against a deadline.
 *
 * @param {Promise|Function} work - the LLM call promise, or a () => Promise.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=LLM_TIMEOUT_MS]
 * @param {string} [opts.label='LLM call']
 * @returns {Promise<*>} the work's result, or rejects with LLMTimeoutError.
 */
export async function withLLMTimeout(work, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : LLM_TIMEOUT_MS
  const label = opts.label || 'LLM call'
  let timer = null
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LLMTimeoutError(label, timeoutMs)), Math.max(1, timeoutMs))
    // Don't keep the event loop alive just for this timer.
    if (typeof timer?.unref === 'function') timer.unref()
  })
  try {
    const p = typeof work === 'function' ? Promise.resolve().then(work) : Promise.resolve(work)
    return await Promise.race([p, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** True for any error raised by withLLMTimeout (or carrying the timeout tag). */
export function isLLMTimeout(err) {
  return Boolean(err && (err.isTimeout || err.code === 'LLM_TIMEOUT'))
}

export default withLLMTimeout
