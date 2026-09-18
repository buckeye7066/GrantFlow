/** Bounded follow-up batches for the existing stale-explain writer, not another matcher. */
export function isStaleMatchRefreshWriteEnabled(opts = {}, env = process.env) {
  return opts.writeEnabled !== false &&
    !/^(0|false|no|off)$/i.test(String(env.ENFORCE_STALE_MATCH_EXPLAIN ?? '1').trim())
}

export function createStaleMatchRefreshRunner(runBatch, {
  environment = () => process.env,
  schedule = setTimeout,
  cancel = clearTimeout,
  report = () => {},
  delayMs = 30000,
  maxPasses = 20,
} = {}) {
  const states = new WeakMap()
  const notify = receipt => { try { report(receipt) } catch { /* Logging must not retry a write. */ } }
  const automatic = opts => opts.autoContinue ?? (environment().NODE_ENV === 'production')

  function invoke(db, opts = {}, continuation = false) {
    // A census must never join a writer or acquire permission to schedule one.
    if (!isStaleMatchRefreshWriteEnabled(opts, environment())) return runBatch(db, opts)
    let state = states.get(db)
    if (!state) {
      state = { running: null, timer: null, passes: 0 }
      states.set(db, state)
    }
    if (state.running) return state.running
    if (state.timer) { cancel(state.timer); state.timer = null }
    if (!continuation) state.passes = 0
    state.passes += 1

    state.running = Promise.resolve().then(() => runBatch(db, opts)).then(summary => {
      let status
      if (summary.ok !== true || (!Number.isSafeInteger(summary.remaining_stale) || summary.remaining_stale < 0)) status = 'failed'
      else if (summary.remaining_stale === 0 && summary.complete === true) status = 'complete'
      else if (!summary.write_enabled || !automatic(opts) || !isStaleMatchRefreshWriteEnabled(opts, environment())) status = 'disabled'
      else if (state.passes >= maxPasses) status = 'pass_limit'
      else if (!Number.isSafeInteger(summary.stale_before) || summary.remaining_stale >= summary.stale_before) status = 'blocked_no_progress'
      else {
        status = 'scheduled'
        state.timer = schedule(async () => {
          state.timer = null
          // Recheck the kill switch at execution, not only when the timer was created.
          if (!isStaleMatchRefreshWriteEnabled(opts, environment()) || !automatic(opts)) {
            states.delete(db)
            notify({ ok: true, complete: false, continuation_status: 'disabled' })
            return
          }
          try { await invoke(db, opts, true) } catch { /* invoke reported the failure. */ }
        }, delayMs)
        state.timer?.unref?.()
      }
      const result = { ...summary, continuation_status: status, continuation_pass: state.passes }
      notify(result)
      return result
    }).catch(error => {
      notify({ ok: false, complete: false, continuation_status: 'failed' })
      throw error
    }).finally(() => {
      state.running = null
      if (!state.timer) states.delete(db)
    })
    return state.running
  }

  return (db, opts = {}) => invoke(db, opts)
}
