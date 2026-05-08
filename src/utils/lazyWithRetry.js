import React from 'react'

/**
 * Wraps `React.lazy` so that "stale chunk" failures after a deploy
 * trigger exactly one full page reload — getting the user the new
 * `index.html` (with the current chunk hashes) without manual
 * cache-clearing.
 *
 * The bug this fixes
 * ------------------
 * When a deploy ships, the user's browser still has the previous
 * `index-*.js` open. That bundle references chunks like
 * `Pipeline-CYxIjBZZ.js` that no longer exist in the new build.
 * Because vercel.json rewrites every unmatched path to `index.html`,
 * fetching the missing chunk returns HTML with `Content-Type: text/html`
 * and the browser refuses it with:
 *
 *   - "Failed to load module script: Expected a JavaScript-or-Wasm
 *      module script but the server responded with a MIME type of
 *      'text/html'."
 *   - "TypeError: Failed to fetch dynamically imported module: …"
 *
 * The corresponding lazy() promise rejects, the route's <Suspense>
 * crashes, the user sees the RouteErrorBoundary fallback. A simple
 * page reload fixes it because the new `index.html` carries the
 * correct chunk hashes.
 *
 * Loop guard
 * ----------
 * If the same chunk fails twice within 10 s the helper RE-THROWS so
 * the boundary catches it instead of looping forever (e.g. if the
 * CDN is genuinely missing the asset, not just stale).
 *
 * Usage
 *   const Pipeline = lazyWithRetry(() => import('./Pipeline'), 'Pipeline')
 */

const RELOAD_TIMESTAMP_KEY = 'grantflow:lazy-reload-ts'
const RELOAD_DEDUPE_WINDOW_MS = 10_000

function looksLikeStaleChunkError(err) {
  const msg = String(err?.message ?? err ?? '')
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /MIME type/i.test(msg) ||
    /ChunkLoadError/i.test(err?.name ?? '')
  )
}

function recentlyReloaded() {
  try {
    const ts = Number(sessionStorage.getItem(RELOAD_TIMESTAMP_KEY) || 0)
    return ts && Date.now() - ts < RELOAD_DEDUPE_WINDOW_MS
  } catch {
    return false
  }
}

function recordReload() {
  try {
    sessionStorage.setItem(RELOAD_TIMESTAMP_KEY, String(Date.now()))
  } catch {
    /* sessionStorage unavailable — fine, we just won't dedupe */
  }
}

export function lazyWithRetry(importFn, chunkLabel = 'chunk') {
  return React.lazy(async () => {
    try {
      const mod = await importFn()
      // Successful load — clear the dedupe stamp so a future stale
      // chunk gets one fresh reload.
      try { sessionStorage.removeItem(RELOAD_TIMESTAMP_KEY) } catch { /* ignore */ }
      return mod
    } catch (err) {
      if (!looksLikeStaleChunkError(err)) {
        throw err
      }
      if (recentlyReloaded()) {
        // We already reloaded once; give up and let the boundary show
        // a message instead of looping.
        console.error(
          `[lazyWithRetry] ${chunkLabel} still missing after reload — bubbling to error boundary`,
          err,
        )
        throw err
      }
      console.warn(
        `[lazyWithRetry] ${chunkLabel} missing (likely a stale deploy) — forcing reload`,
        err?.message ?? err,
      )
      recordReload()
      window.location.reload()
      // Return an empty placeholder while the reload happens so React
      // doesn't render anything during the brief flash before unload.
      return { default: () => null }
    }
  })
}

export default lazyWithRetry
