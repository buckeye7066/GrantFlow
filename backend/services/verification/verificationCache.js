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
 * The ONLY hosts the verification providers are allowed to reach. Query
 * params legitimately carry profile-derived values (EIN, name, ZIP), so the
 * host must be pinned here — a future caller (or a tainted interpolation)
 * can never turn this helper into an open proxy toward internal addresses
 * (SSRF). Growing this set is a conscious review decision.
 */
export const VERIFICATION_ALLOWED_ORIGINS = Object.freeze({
  // hostname -> constant https origin. The fetch target is REBUILT from the
  // matched constant (never from the caller's string), so the request host is
  // provably one of these two values.
  'projects.propublica.org': 'https://projects.propublica.org', // IRS nonprofit registry
  'geocoding.geo.census.gov': 'https://geocoding.geo.census.gov', // Census geocoder
})

export const VERIFICATION_ALLOWED_HOSTS = Object.freeze(new Set(Object.keys(VERIFICATION_ALLOWED_ORIGINS)))

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
  // SSRF guard: pin the request to the fixed public-API hosts. The URL's
  // path/query carry profile-derived values by design; the HOST never may.
  // Parse-then-compare (never substring — the
  // js/incomplete-url-substring-sanitization class), https only — and the
  // actual fetch target is REBUILT from the matched CONSTANT origin plus the
  // parsed path/query, so untrusted input structurally cannot select the
  // authority even if this guard were bypassed upstream.
  const parsed = new URL(String(url))
  const allowedOrigin = VERIFICATION_ALLOWED_ORIGINS[parsed.hostname]
  if (parsed.protocol !== 'https:' || !allowedOrigin) {
    throw new Error(`verification fetch refused: host not allowlisted (${parsed.hostname})`)
  }
  const target = allowedOrigin + parsed.pathname + parsed.search
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs))
  try {
    return await fetch(target, {
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
