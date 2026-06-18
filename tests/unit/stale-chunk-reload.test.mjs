/**
 * Stale-chunk reload helper (chunk-load resilience).
 *
 * maybeReloadForStaleChunk() is the shared entry point used by the global
 * vite:preloadError / unhandledrejection handlers in main.jsx and by
 * RouteErrorBoundary. It must: reload exactly once for a stale-chunk error,
 * ignore unrelated errors, and NOT loop (dedupe within the window).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// Stub the browser globals the helper touches BEFORE importing it.
let reloadCount = 0
const store = new Map()
globalThis.window = {
  location: { reload: () => { reloadCount += 1 } },
  addEventListener: () => {},
}
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

const { maybeReloadForStaleChunk } = await import('../../src/utils/lazyWithRetry.js')

test('ignores a non-chunk error (no reload)', () => {
  reloadCount = 0
  store.clear()
  const handled = maybeReloadForStaleChunk(new Error('something unrelated'))
  assert.equal(handled, false)
  assert.equal(reloadCount, 0)
})

test('reloads exactly once for a stale-chunk error, then dedupes', () => {
  reloadCount = 0
  store.clear()
  const err = new Error('Failed to fetch dynamically imported module: /assets/Admin-abc123.js')

  // First hit: reloads.
  assert.equal(maybeReloadForStaleChunk(err), true)
  assert.equal(reloadCount, 1)

  // Second hit within the dedupe window: must NOT reload again (no loop).
  assert.equal(maybeReloadForStaleChunk(err), false)
  assert.equal(reloadCount, 1)
})

test('recognises ChunkLoadError by name', () => {
  reloadCount = 0
  store.clear()
  const err = new Error('Loading chunk 42 failed')
  err.name = 'ChunkLoadError'
  assert.equal(maybeReloadForStaleChunk(err), true)
  assert.equal(reloadCount, 1)
})
