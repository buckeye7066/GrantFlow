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

/**
 * The SINGLE source of truth for "does this error mean the user is on a stale
 * deploy and asked for a chunk that no longer matches the current build?"
 *
 * Exported so RouteErrorBoundary consumes the exact same predicate — a second,
 * hand-kept copy drifted before (it missed the `.default` shape below, which is
 * why a real deploy produced an owner-facing 500 instead of a silent reload).
 */
export function looksLikeStaleChunkError(err) {
  const msg = String(err?.message ?? err ?? '')
  const name = String(err?.name ?? '')
  return (
    // The dynamic import() itself failed / was served the wrong MIME type.
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /MIME type/i.test(msg) ||
    // The chunk FETCHED but resolved to a malformed/undefined module namespace,
    // so React.lazy reads `.default` off `undefined` synchronously at render
    // time (surfaces via the error boundary, not a rejected promise). A
    // correctly-built local module never does this — a genuine missing default
    // export fails the build or renders as "Element type is invalid" — so this
    // shape is a stale/partial-chunk artifact, and the shared reload dedupe
    // guarantees at most one reload before the boundary shows its message.
    /Cannot read propert(?:y|ies) of undefined \(reading 'default'\)/i.test(msg) ||
    /Cannot read property 'default' of undefined/i.test(msg) ||
    /undefined is not an object \(evaluating '[^']*\.default'\)/i.test(msg) ||
    /ChunkLoadError/i.test(name)
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

/**
 * Shared entry point for the global handlers (vite:preloadError /
 * unhandledrejection) in main.jsx. If `err` looks like a stale-chunk failure
 * and we haven't already reloaded in the dedupe window, force exactly one
 * reload and return true (so the caller can preventDefault). Returns false
 * when it's not a stale chunk, or when we've already reloaded once (let the
 * error boundary show its message instead of looping).
 */
export function maybeReloadForStaleChunk(err) {
  if (!looksLikeStaleChunkError(err)) return false
  if (recentlyReloaded()) {
    console.error('[chunk] stale chunk persisted after one reload — not looping', err?.message ?? err)
    return false
  }
  console.warn('[chunk] stale chunk detected (likely a fresh deploy) — forcing one reload', err?.message ?? err)
  recordReload()
  try { window.location.reload() } catch { /* SSR / no window */ }
  return true
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
