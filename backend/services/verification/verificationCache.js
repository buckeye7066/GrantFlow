/**
 * verificationCache.js
 *
 * A tiny, dependency-free in-memory TTL+LRU cache and a timeout-bounded fetch
 * helper shared by the verification providers (ProPublica + Census).
 *
 * Why in-memory (not Postgres):
 *   IRS/Census lookups are pure functions of a stable key (EIN / normalized
 *   name / ZIP) and the underlying data changes at most yearly. A bounded
 *   process-local cache removes the vast majority of repeat calls inside a
 *   single discovery run (the only place these are called in any volume),
 *   with zero schema/migration surface. Follows the same lightweight pattern
 *   used elsewhere in backend/services (plain `Map`-backed caches).
 *
 * The cache is bounded (LRU eviction) so it can never grow unbounded across a
 * long-lived backend process.
 */

import fetch from 'node-fetch'

const MAX_ENTRIES = Number(process.env.VERIFICATION_CACHE_MAX_ENTRIES || 5000)

/**
 * Create a bounded TTL cache. Keys are strings, values are arbitrary.
 * @param {object} [opts]
 * @param {number} [opts.max] max entries before LRU eviction
 */
export function createTtlCache({ max = MAX_ENTRIES } = {}) {
  // Map preserves insertion order, which we use for cheap LRU eviction:
  // on read we re-insert (move-to-end); on overflow we delete the oldest key.
  const store = new Map()

  function get(key, ttlMs) {
    const entry = store.get(key)
    if (!entry) return undefined
    if (ttlMs > 0 && Date.now() - entry.at > ttlMs) {
      store.delete(key)
      return undefined
    }
    // Move-to-end (mark as most-recently-used).
    store.delete(key)
    store.set(key, entry)
    return entry.value
  }

  function set(key, value) {
    if (store.has(key)) store.delete(key)
    store.set(key, { value, at: Date.now() })
    while (store.size > max) {
      const oldest = store.keys().next().value
      store.delete(oldest)
    }
  }

  function clear() {
    store.clear()
  }

  return { get, set, clear, get size() { return store.size } }
}

/**
 * fetch with a hard timeout. Resolves the Response on success; on timeout or
 * network error THROWS (callers must catch and degrade gracefully — these
 * providers never let an error escape to the matcher/discovery path).
 *
 * Uses AbortController so an un-responsive endpoint cannot stall discovery.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=4000]
 * @param {object} [opts.headers]
 * @returns {Promise<import('node-fetch').Response>}
 */
export async function timedFetch(url, { timeoutMs = 4000, headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs))
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        // Identify ourselves politely; both APIs are public + keyless.
        'User-Agent': 'GrantFlow/1.0 (grant verification; +https://grantflow.app)',
        Accept: 'application/json',
        ...headers,
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

export default { createTtlCache, timedFetch }
