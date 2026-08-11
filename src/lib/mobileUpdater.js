// Mobile OTA update helpers for the native (Capacitor) Android/iOS app.
//
// The native app ships a web bundle baked in at build time. Newer web bundles
// are published to the production host as `/mobile/latest.json` + a zip (see
// scripts/build-mobile-bundle.mjs). The Settings page exposes a manual
// "Check for Updates" control (no background auto-update — autoUpdate is
// disabled in capacitor.config.json) that downloads and applies the bundle via
// @capgo/capacitor-updater.
//
// Everything here that can be pure IS pure so it can be unit tested without a
// device: semver comparison, manifest validation, and the update decision.

/** Production origin that hosts /mobile/latest.json + bundle zips. */
export const UPDATE_BASE_URL = 'https://axiombiolabs.org'

/**
 * Dev/test override: set localStorage['grantflow.mobileUpdateFeedUrl'] to a
 * full manifest URL to point the checker somewhere else (e.g. a locally
 * served latest.json through `adb reverse`). Never used unless explicitly set.
 */
export const FEED_URL_OVERRIDE_KEY = 'grantflow.mobileUpdateFeedUrl'

/** A manual update check must not leave the Settings action spinning forever. */
export const UPDATE_MANIFEST_TIMEOUT_MS = 12_000

/**
 * Parse a semver-ish version string into numeric parts.
 * Returns null when the input is not a dotted numeric version (e.g. capgo's
 * "builtin" placeholder), so callers can fall back to the baked app version.
 * @param {unknown} value
 * @returns {number[] | null}
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^v/i, '')
  if (!/^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/.test(trimmed)) return null
  const core = trimmed.split('-')[0]
  return core.split('.').map((part) => Number.parseInt(part, 10))
}

/**
 * Compare two version strings numerically.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a<b, 0 when equal/incomparable, positive when a>b
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * @param {string} candidate version offered by the update feed
 * @param {string} current currently-active bundle version
 * @returns {boolean} true only when candidate is strictly newer
 */
export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0
}

/**
 * Validate the fetched manifest shape. Returns the normalized manifest or
 * throws with an honest, user-displayable reason. The prod host serves the
 * SPA's index.html for unknown paths, so "we got HTML back" must surface as
 * "no update feed yet", never as a crash.
 * @param {unknown} raw
 * @returns {{ version: string, url: string, notes: string, builtAt: string }}
 */
export function parseUpdateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Update feed is not available yet (no manifest published).')
  }
  const { version, url } = /** @type {Record<string, unknown>} */ (raw)
  if (!parseVersion(version)) {
    throw new Error('Update feed has an invalid version field.')
  }
  if (typeof url !== 'string') {
    throw new Error('Update feed has an invalid bundle URL (must be absolute https).')
  }
  let bundleUrl
  try {
    bundleUrl = new URL(url)
  } catch {
    throw new Error('Update feed has an invalid bundle URL (must be absolute https).')
  }
  if (bundleUrl.protocol !== 'https:' || !bundleUrl.hostname) {
    throw new Error('Update feed has an invalid bundle URL (must be absolute https).')
  }
  return {
    version: String(version),
    url,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : '',
  }
}

/**
 * Resolve the manifest URL (prod feed unless a dev override is set).
 * @param {{ localStorage?: Pick<Storage, 'getItem'> }} [opts]
 */
export function resolveFeedUrl({ localStorage: ls } = {}) {
  try {
    const store = ls ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    const override = store?.getItem(FEED_URL_OVERRIDE_KEY)
    if (override && /^https?:\/\//.test(override)) return override
  } catch {
    // storage unavailable — fall through to prod feed
  }
  return `${UPDATE_BASE_URL}/mobile/latest.json`
}

/**
 * Fetch and validate the update manifest (no-cache).
 * @param {{ fetchImpl?: typeof fetch, feedUrl?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ version: string, url: string, notes: string, builtAt: string }>}
 */
export async function fetchUpdateManifest({ fetchImpl, feedUrl, timeoutMs = UPDATE_MANIFEST_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl ?? fetch
  const url = feedUrl ?? resolveFeedUrl()
  const sep = url.includes('?') ? '&' : '?'
  const controller = typeof AbortController === 'undefined' ? null : new AbortController()
  let timedOut = false
  let timeoutId
  let response
  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        controller?.abort()
        reject(new Error('Update check timed out. Please try again.'))
      }, timeoutMs)
    })
    response = await Promise.race([
      doFetch(`${url}${sep}ts=${Date.now()}`, { cache: 'no-store', signal: controller?.signal }),
      timeout,
    ])
  } catch {
    if (timedOut) throw new Error('Update check timed out. Please try again.')
    throw new Error('Could not reach the update server. Check your connection and try again.')
  } finally {
    clearTimeout(timeoutId)
  }
  if (!response.ok) {
    throw new Error(`Update check failed (HTTP ${response.status}).`)
  }
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new Error('Update feed is not available yet (no manifest published).')
  }
  return parseUpdateManifest(parsed)
}
