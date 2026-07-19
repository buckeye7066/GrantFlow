/**
 * gracefulShutdown.js — clean SIGTERM/SIGINT handling for the HTTP server.
 *
 * WHY THIS EXISTS (2026-07-17): every Railway deploy emailed "Deploy Crashed"
 * for the SUPERSEDED deployment. The cause was here, not in boot. `server.js`
 * sets `keepAliveTimeout = 620s` (a deliberate fix for bodiless 502s behind the
 * Railway/Vercel edge — the proxy must always be the side that closes an idle
 * socket first). But `server.close()` waits for EVERY open connection to end,
 * and an idle keep-alive lingers for those 620 seconds. So on a deploy swap,
 * Railway SIGTERMs the old container, `server.close()` cannot finish, the
 * old force-timeout fired and called `process.exit(1)`, and a non-zero exit is
 * what Railway records as a crash — on an otherwise perfectly healthy app.
 *
 * The fix is two lines of intent:
 *   1. `closeIdleConnections()` immediately, so `server.close()` finishes in
 *      milliseconds instead of waiting out the 620s keep-alive.
 *   2. An expected shutdown exits ZERO — even the force-timeout path — because a
 *      deploy-swap SIGTERM is not a crash. (A real boot/runtime failure exits
 *      through a different path; this function is only reached on request.)
 *
 * Pure and injectable so the behavior is unit-tested without booting the app.
 */
export function runGracefulShutdown({
  server,
  closeDb,
  flush,
  exit,
  log = console,
  graceMs = 15000,
} = {}) {
  if (!server) {
    exit?.(0)
    return
  }

  // Release idle keep-alive sockets NOW so server.close() is not held open for
  // the full keepAliveTimeout. Guarded: added in Node 18.2, best-effort on older.
  try { server.closeIdleConnections?.() } catch { /* best-effort */ }

  let settled = false
  const finish = async (code) => {
    if (settled) return
    settled = true
    try {
      const maybe = closeDb?.()
      if (maybe && typeof maybe.then === 'function') await maybe
    } catch (err) {
      log.error?.('[shutdown] error closing database:', err?.message || err)
    }
    try {
      const f = flush?.()
      if (f && typeof f.then === 'function') await f
    } catch { /* best-effort */ }
    exit?.(code)
  }

  server.close(() => finish(0))

  // Deploy-swap SIGTERM is EXPECTED — force the remaining sockets closed and exit
  // ZERO if in-flight requests do not drain in time. A non-zero exit here was the
  // "Deploy Crashed" trigger.
  const timer = setTimeout(() => {
    log.warn?.('[shutdown] drain window elapsed — forcing remaining connections closed')
    try { server.closeAllConnections?.() } catch { /* best-effort */ }
    finish(0)
  }, graceMs)
  // Do not let the timer itself keep the event loop alive.
  if (typeof timer.unref === 'function') timer.unref()
}

export default runGracefulShutdown
