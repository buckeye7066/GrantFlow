/**
 * Hamilton browser target policy.
 *
 * When browser automation is enabled, Hamilton may drive public HTTPS portal
 * origins (plus the reserved synthetic fixture used by irreversible-boundary
 * tests). Private / loopback / link-local / metadata addresses stay blocked
 * forever (SSRF). Environment allowlists and saved credentials do not widen
 * past that SSRF floor — they only narrow which public hosts are eligible when
 * an allowlist is configured (see browserAutomationPermittedForUrl).
 */

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN =
  'https://hamilton-submit-fixture.invalid'

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST =
  new URL(CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN).hostname

function asHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '')
}

/** True for loopback, RFC1918, link-local, and cloud-metadata addresses. */
export function isPrivateOrLocalHostname(hostname) {
  const h = asHostname(hostname)
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true
  if (h === '::1' || h === '[::1]') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true
  return false
}

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

/** Public HTTPS portal URL Hamilton may open when browser automation is on. */
export function isPublicHttpsPortalUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    if (isPrivateOrLocalHostname(url.hostname)) return false
    return true
  } catch {
    return false
  }
}

/**
 * A saved portal link is often `http://` (older catalog rows, hand-typed
 * application_url values, redirects captured before the site moved to TLS).
 * Public sites answer on HTTPS, and refusing the plain-http form as a
 * "private, loopback, or unsafe target" was a false stop measured in prod
 * 2026-08-31 (www.aauw.org, www.nsf.gov, jkcf.org — every one a public funder
 * site). Upgrade the scheme for PUBLIC hosts only; anything private/loopback
 * stays exactly as it was so the SSRF floor is untouched. Non-URLs and
 * non-http schemes are returned unchanged.
 */
export function normalizeBrowserTargetUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return raw
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:') return raw
    if (url.username || url.password) return raw
    if (isPrivateOrLocalHostname(url.hostname)) return raw
    url.protocol = 'https:'
    // A literal :80 no longer makes sense once the scheme is https.
    if (url.port === '80') url.port = ''
    return url.toString()
  } catch {
    return raw
  }
}

/** Navigation targets: reserved fixture OR public HTTPS (SSRF-safe). */
export function isHamiltonBrowserTargetAllowed(value) {
  return isControlledBetaSyntheticBrowserUrl(value) || isPublicHttpsPortalUrl(value)
}

/**
 * Request/subresource/redirect egress: fixture, blank/data, or any
 * http(s) host that is not private/loopback/metadata.
 */
export function isHamiltonBrowserRequestAllowed(value) {
  const raw = String(value || '')
  if (isControlledBetaSyntheticBrowserUrl(raw)) return true
  if (raw === 'about:blank' || raw.startsWith('data:')) return true
  if (raw.startsWith('blob:')) {
    return isHamiltonBrowserTargetAllowed(raw.slice('blob:'.length))
  }
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    return !isPrivateOrLocalHostname(url.hostname)
  } catch {
    return false
  }
}

/** @deprecated Prefer isHamiltonBrowserRequestAllowed — kept for import stability. */
export function isControlledBetaBrowserRequestAllowed(value) {
  return isHamiltonBrowserRequestAllowed(value)
}

export function controlledBetaBrowserRefusal() {
  return {
    code: 'controlled_beta_manual_handoff',
    message: 'Hamilton cannot open this address in a server browser (private, loopback, or unsafe target). Use a public HTTPS portal URL, or open the official portal yourself.',
  }
}

export function unsafeBrowserTargetRefusal() {
  return controlledBetaBrowserRefusal()
}

/**
 * Install before the first page/request. Aborts SSRF-class destinations while
 * allowing public portal hosts and the reserved synthetic fixture.
 */
export async function installControlledBetaBrowserEgressGuard(context) {
  if (!context || typeof context.route !== 'function') {
    throw new Error('controlled_beta_browser_guard_unavailable')
  }
  await context.route('**/*', async (route) => {
    let requestUrl = ''
    try { requestUrl = route.request().url() } catch { /* fail closed below */ }
    if (isHamiltonBrowserRequestAllowed(requestUrl)) {
      await route.continue()
      return
    }
    await route.abort('blockedbyclient')
  })
}

export function controlledBetaBrowserContextOptions(options = {}) {
  return { ...options, serviceWorkers: 'block' }
}
