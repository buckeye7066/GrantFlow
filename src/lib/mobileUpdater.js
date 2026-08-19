// Mobile OTA update helpers for the native (Capacitor) Android/iOS app.
//
// The native app ships a web bundle baked in at build time. Newer web bundles
// are published to the production host as `/mobile/latest.json` + a zip (see
// scripts/build-mobile-bundle.mjs). Two consumers drive the same helpers:
//   * src/components/mobile/MobileUpdateWatcher.jsx — checks on launch and on
//     resume, raises a local notification, and prompts in-app;
//   * src/components/settings/MobileUpdateCard.jsx — the manual
//     "Check for Updates" control.
// The plugin's own autoUpdate stays disabled in capacitor.config.json; every
// install goes through downloadAndApplyUpdate() below, which is the ONLY place
// a bundle is handed to @capgo/capacitor-updater — and it fails closed without
// a published checksum.
//
// Everything here that can be pure IS pure so it can be unit tested without a
// device: semver comparison, manifest validation, the update decision, the
// native-floor decision, and the fail-closed integrity gate.

/** Production origin that hosts /mobile/latest.json + bundle zips. */
export const UPDATE_BASE_URL = 'https://axiombiolabs.org'

/**
 * DEV-BUILD-ONLY override: set localStorage['grantflow.mobileUpdateFeedUrl'] to
 * a full manifest URL to point the checker somewhere else (e.g. a locally
 * served latest.json through `adb reverse`).
 *
 * SECURITY: this is honored ONLY when `import.meta.env.DEV` is true. In a
 * production build the feed origin is pinned to {@link UPDATE_BASE_URL}, because
 * anything that can write localStorage (an XSS, a malicious deep link, a
 * third-party script) could otherwise repoint the updater at an attacker's
 * bundle and get arbitrary code executed inside the native app.
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

/** Lowercase hex sha256 of the published bundle zip (64 hex chars). */
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Validate the fetched manifest shape. Returns the normalized manifest or
 * throws with an honest, user-displayable reason. The prod host serves the
 * SPA's index.html for unknown paths, so "we got HTML back" must surface as
 * "no update feed yet", never as a crash.
 * @param {unknown} raw
 * @returns {{ version: string, url: string, sha256: string, minNativeVersion: string, notes: string, builtAt: string }}
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
  // Integrity: a published sha256 must be a well-formed lowercase hex digest.
  // A malformed one is rejected here rather than being forwarded to the native
  // plugin, where it would fail late with an opaque error. A MISSING sha256 is
  // allowed through by the parser (older feeds predate the field) and is
  // refused at apply time by requireVerifiableBundle() — the fail-closed gate.
  // An absent field and an empty string both mean "not declared" — only a
  // present, non-empty, malformed value is an error.
  const rawSha = /** @type {Record<string, unknown>} */ (raw).sha256
  const shaDeclared = rawSha !== undefined && rawSha !== ''
  if (shaDeclared && (typeof rawSha !== 'string' || !SHA256_HEX.test(rawSha.trim().toLowerCase()))) {
    throw new Error('Update feed has an invalid bundle checksum.')
  }

  const rawMinNative = /** @type {Record<string, unknown>} */ (raw).minNativeVersion
  const minNativeDeclared = rawMinNative !== undefined && rawMinNative !== ''
  if (minNativeDeclared && !parseVersion(rawMinNative)) {
    throw new Error('Update feed has an invalid minimum app version.')
  }

  return {
    version: String(version),
    url,
    sha256: typeof rawSha === 'string' ? rawSha.trim().toLowerCase() : '',
    minNativeVersion: typeof rawMinNative === 'string' ? rawMinNative.trim() : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : '',
  }
}

/**
 * Resolve the manifest URL.
 *
 * Production is PINNED to {@link UPDATE_BASE_URL}. The localStorage override is
 * honored only in a dev build, so a localStorage write in a shipped app cannot
 * repoint the updater at a foreign bundle host.
 *
 * @param {{ localStorage?: Pick<Storage, 'getItem'>, isDev?: boolean }} [opts]
 */
export function resolveFeedUrl({ localStorage: ls, isDev } = {}) {
  const devBuild = isDev ?? import.meta.env?.DEV === true
  if (devBuild) {
    try {
      const store = ls ?? (typeof localStorage !== 'undefined' ? localStorage : null)
      const override = store?.getItem(FEED_URL_OVERRIDE_KEY)
      if (override && /^https?:\/\//.test(override)) return override
    } catch {
      // storage unavailable — fall through to prod feed
    }
  }
  return `${UPDATE_BASE_URL}/mobile/latest.json`
}

/**
 * Does this manifest require a NEWER NATIVE app than the one running?
 *
 * OTA swaps the web bundle only; it can never deliver native code or a new
 * Capacitor plugin. When a bundle declares a `minNativeVersion` above the
 * installed native app version, the correct answer is "install a new app
 * version from the store", NOT a web update that cannot carry the change.
 *
 * @param {{ minNativeVersion?: string }} manifest
 * @param {string} nativeVersion the running native app version (CapacitorUpdater.current().native)
 * @returns {boolean} true only when both versions parse AND the floor is higher
 */
export function requiresNativeUpdate(manifest, nativeVersion) {
  const floor = manifest?.minNativeVersion
  if (!parseVersion(floor) || !parseVersion(nativeVersion)) return false
  return compareVersions(floor, nativeVersion) > 0
}

/**
 * FAIL CLOSED: refuse to hand an unverifiable bundle to the native updater.
 *
 * The plugin only verifies integrity when a checksum is supplied — call it with
 * no checksum and it happily installs whatever bytes came back from the network.
 * So an update with no published sha256 is refused here rather than applied.
 *
 * @param {{ sha256?: string }} manifest
 * @returns {string} the validated lowercase hex digest
 * @throws {Error} when the manifest carries no usable checksum
 */
export function requireVerifiableBundle(manifest) {
  const sha = typeof manifest?.sha256 === 'string' ? manifest.sha256.trim().toLowerCase() : ''
  if (!SHA256_HEX.test(sha)) {
    throw new Error('Update refused: this bundle has no published checksum, so it cannot be verified.')
  }
  return sha
}

/**
 * Download, VERIFY, and apply an OTA bundle. Shared by the Settings card and
 * the launch/resume update prompt so there is exactly one apply path — and
 * therefore exactly one place where verification can be bypassed (it can't).
 *
 * Verification is performed by the native plugin: @capgo/capacitor-updater
 * SHA-256s the downloaded zip and throws when it does not equal the `checksum`
 * we pass, on both Android and iOS. We refuse to call it at all without one.
 *
 * @param {object} opts
 * @param {{ version: string, url: string, sha256?: string }} opts.manifest
 * @param {{ download: Function, set: Function, addListener?: Function }} opts.updater CapacitorUpdater
 * @param {(percent: number) => void} [opts.onProgress]
 * @returns {Promise<void>} resolves once set() has been called (the webview then reloads)
 */
export async function downloadAndApplyUpdate({ manifest, updater, onProgress }) {
  const checksum = requireVerifiableBundle(manifest)
  let listener = null
  try {
    if (onProgress && typeof updater.addListener === 'function') {
      listener = await updater.addListener('download', (event) => {
        if (typeof event?.percent === 'number') onProgress(event.percent)
      })
    }
    const bundle = await updater.download({
      url: manifest.url,
      version: manifest.version,
      checksum,
    })
    listener?.remove?.()
    listener = null
    // set() swaps to the verified bundle and reloads the webview.
    await updater.set(bundle)
  } catch (err) {
    listener?.remove?.()
    throw err
  }
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
