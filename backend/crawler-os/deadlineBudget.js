/** One caller deadline across a sequence of asynchronous discovery operations. */
export function createDeadlineBudget({ deadlineMs = null, signal = null, clock = Date.now } = {}) {
  const deadline = deadlineMs !== null && deadlineMs !== undefined && Number.isFinite(Number(deadlineMs))
    ? Number(deadlineMs) : null
  const remaining = () => deadline === null ? null : Math.max(0, deadline - clock())
  const stopped = () => signal?.aborted === true || remaining() === 0
  const reason = () => signal?.aborted === true ? 'aborted' : 'time_budget_exhausted'
  const abortError = () => Object.assign(new Error(reason()), { name: 'AbortError' })
  const throwIfStopped = () => { if (stopped()) throw abortError() }
  async function run(work, additionalSignal = null) {
    throwIfStopped()
    additionalSignal?.throwIfAborted()
    if (deadline === null && !signal && !additionalSignal) return work({})
    const controller = new AbortController()
    const active = AbortSignal.any([controller.signal, signal, additionalSignal].filter(Boolean))
    const left = remaining()
    const timer = left === null ? null : setTimeout(() => controller.abort(abortError()), left)
    let rejectOnAbort
    const aborted = new Promise((_, reject) => {
      rejectOnAbort = () => reject(active.reason || abortError())
      active.addEventListener('abort', rejectOnAbort, { once: true })
      if (active.aborted) rejectOnAbort()
    })
    try {
      return await Promise.race([aborted, Promise.resolve().then(() => {
        active.throwIfAborted()
        return work({ signal: active, ...(left === null ? {} : { timeoutMs: left, deadlineMs: deadline }) })
      })])
    } finally {
      clearTimeout(timer)
      active.removeEventListener('abort', rejectOnAbort)
    }
  }
  return { run, remaining, stopped, reason, throwIfStopped }
}
