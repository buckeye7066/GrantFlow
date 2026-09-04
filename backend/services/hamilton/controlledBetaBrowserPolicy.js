/**
 * Hamilton browser boundary policies.
 *
 * Two policies co-exist:
 *
 * 1. SYNTHETIC FIXTURE (controlled-beta tests only)
 *    A reserved `.invalid` origin used exclusively by irreversible-boundary
 *    tests. `isControlledBetaSyntheticBrowserUrl` / `isControlledBetaBrowserRequestAllowed`
 *    / `installControlledBetaBrowserEgressGuard` cover this path and remain
 *    unchanged so the fixture-based test suite keeps passing.
 *
 * 2. REAL PUBLIC PORTAL (production autopilot)
 *    When `allow_auto_submit` is ON and a real portal URL is authorised,
 *    Hamilton launches a Chromium context against the public HTTPS site.
 *    `isPublicHttpsPortalUrl` is the admission gate (HTTPS only, no private
 *    IPs, no loopback, no cloud-metadata endpoints).
 *    `installPortalBrowserEgressGuard` installs a Playwright route-level guard
 *    that aborts requests to private/loopback/metadata destinations while
 *    allowing legitimate CDN subresources, redirects, and auth SSO hops.
 */

import { SSRF_BLOCKED_HOSTS, assertSsrfSafeUrl, isPrivateIp } from '../../config/urlRules.js'

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN =
  'https://hamilton-submit-fixture.invalid'

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST =
  new URL(CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN).hostname

export function isControlledBetaSyntheticBrowserUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.origin === CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN
      && url.protocol === 'https:'
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

/** Non-network document URLs are harmless; every HTTP(S) request stays on the fixture origin. */
export function isControlledBetaBrowserRequestAllowed(value) {
  const raw = String(value || '')
  if (isControlledBetaSyntheticBrowserUrl(raw)) return true
  if (raw === 'about:blank' || raw.startsWith('data:')) return true
  if (raw.startsWith('blob:')) {
    return isControlledBetaSyntheticBrowserUrl(raw.slice('blob:'.length))
  }
  return false
}

export function controlledBetaBrowserRefusal() {
  return {
    code: 'controlled_beta_manual_handoff',
    message: 'Controlled beta does not open real portal sites in a server browser. Hamilton prepared the available packet or draft; open the official portal yourself for login, review, and final submission.',
  }
}

/**
 * Install before the first page/request. Playwright routing covers redirects,
 * popup/new-tab requests, subresources, and fetch/XHR. Blocking service workers
 * on context creation keeps them from bypassing the route handler.
 */
export async function installControlledBetaBrowserEgressGuard(context) {
  if (!context || typeof context.route !== 'function') {
    throw new Error('controlled_beta_browser_guard_unavailable')
  }
  await context.route('**/*', async (route) => {
    let requestUrl = ''
    try { requestUrl = route.request().url() } catch { /* fail closed below */ }
    if (isControlledBetaBrowserRequestAllowed(requestUrl)) {
      await route.continue()
      return
    }
    await route.abort('blockedbyclient')
  })
}

export function controlledBetaBrowserContextOptions(options = {}) {
  return { ...options, serviceWorkers: 'block' }
}

// ── Real public-portal policy ─────────────────────────────────────────────

/**
 * Is `url` safe to open in a Hamilton server-side browser targeting a REAL
 * public portal?  Requirements:
 *   - HTTPS protocol only (real portals must use TLS)
 *   - hostname is NOT in the SSRF_BLOCKED_HOSTS list
 *   - hostname does NOT end with `.invalid` (reserved TLD — no real portal)
 *   - hostname is NOT a private / loopback / link-local / cloud-metadata IP
 *
 * The synthetic fixture is intentionally excluded here; callers that need to
 * accept both (e.g. tests) should check `isControlledBetaSyntheticBrowserUrl`
 * first.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isPublicHttpsPortalUrl(url) {
  try {
    const parsed = new URL(String(url || ''))
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!host) return false
    if (SSRF_BLOCKED_HOSTS.has(host)) return false
    if (host.endsWith('.invalid')) return false
    // Only call isPrivateIp for IP literals (dotted-quad IPv4 or IPv6 with colons).
    // isPrivateIp returns true for non-IP strings (fail-closed), so applying it
    // to a real hostname would incorrectly block every public portal domain.
    if (_isIpLiteral(host) && isPrivateIp(host)) return false
    return true
  } catch {
    return false
  }
}

/**
 * Network-aware admission check for a real portal.  The synchronous predicate
 * above is deliberately only a URL-shape check; every browser boundary must
 * use this function before allowing network egress so a public-looking name
 * which resolves to loopback/private/link-local space is refused.
 */
export async function assertPublicHttpsPortalUrl(url) {
  if (!isPublicHttpsPortalUrl(url)) return { ok: false, reason: 'unsafe_portal_url' }
  const verdict = await assertSsrfSafeUrl(String(url))
  return verdict.ok ? { ok: true } : verdict
}

/**
 * Synchronous per-request allow/deny for a Playwright real-portal context.
 * Blocks requests to private / loopback / metadata destinations while allowing
 * all public HTTP(S) traffic (CDN assets, auth provider SSO hops, etc.).
 * Also allows non-network resources (about:blank, data:, blob:).
 *
 * @param {string} raw  raw URL string from `route.request().url()`
 * @returns {boolean}  true → continue, false → abort
 */
export function isPortalBrowserRequestAllowed(raw) {
  if (!raw || raw === 'about:blank' || raw.startsWith('data:')) return true
  if (raw.startsWith('blob:')) {
    try {
      const inner = raw.slice('blob:'.length)
      const parsed = new URL(inner)
      return !_isPortalHostBlocked(parsed.hostname)
    } catch { return false }
  }
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    return !_isPortalHostBlocked(parsed.hostname)
  } catch {
    return false
  }
}

function _isIpLiteral(host) {
  // IPv4: four decimal octets
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  // IPv6: contains a colon
  if (host.includes(':')) return true
  return false
}

function _isPortalHostBlocked(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (SSRF_BLOCKED_HOSTS.has(h)) return true
  if (_isIpLiteral(h) && isPrivateIp(h)) return true
  return false
}

/**
 * Install before the first page/request in a REAL-portal Playwright context.
 * Blocks private/loopback/metadata destinations; allows all public traffic.
 * Mirrors the structure of `installControlledBetaBrowserEgressGuard` so the
 * two guards can be called interchangeably.
 *
 * @param {import('playwright').BrowserContext} context
 */
export async function installPortalBrowserEgressGuard(context) {
  if (!context || typeof context.route !== 'function') {
    throw new Error('portal_browser_guard_unavailable')
  }
  await context.route('**/*', async (route) => {
    let requestUrl = ''
    try { requestUrl = route.request().url() } catch { /* fail closed below */ }
    // Resolve every HTTP(S) request, including redirects.  Checking only the
    // hostname string permits attacker.example -> 127.0.0.1 and DNS rebinding.
    const networkVerdict = isPortalBrowserRequestAllowed(requestUrl)
      ? (/^https?:/i.test(requestUrl) ? await assertSsrfSafeUrl(requestUrl) : { ok: true })
      : { ok: false }
    if (networkVerdict.ok) {
      await route.continue()
      return
    }
    await route.abort('blockedbyclient')
  })
}
