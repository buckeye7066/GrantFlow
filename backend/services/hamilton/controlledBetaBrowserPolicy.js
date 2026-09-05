/**
 * Hamilton browser target policy.
 *
 * When browser automation is enabled, Hamilton may drive public HTTPS portal
 * origins (plus the reserved synthetic fixture used by irreversible-boundary
 * tests). Private / loopback / link-local / metadata addresses stay blocked
 * forever (SSRF). Environment allowlists and saved credentials do not widen
 * past that SSRF floor — they only narrow which public hosts are eligible when
 * an allowlist is configured (see browserAutomationPermittedForUrl).
 *
 * TWO LAYERS, ported from PRs #1515/#1520 (2026-09-05):
 *
 *   1. URL SHAPE (synchronous): `isPublicHttpsPortalUrl` /
 *      `isHamiltonBrowserRequestAllowed` refuse private / loopback / metadata
 *      hostnames and IP literals by inspection. Cheap, but a public-looking
 *      NAME that resolves to 127.0.0.1 or 10.x passes it.
 *   2. DNS RESOLUTION (async): `resolvePublicBrowserTarget` resolves every
 *      A/AAAA answer before egress and refuses when ANY answer is private, and
 *      detects DNS rebinding against the first pinned answer set for a host.
 *      The shared launcher runs it once for the launch target; the egress guard
 *      runs it for EVERY http(s) request in the context — subresources,
 *      redirects, popups, fetch/XHR — so a redirect chain cannot land on
 *      internal infrastructure.
 *
 * Neither layer re-imposes a host allowlist or a human hand-off: a real public
 * HTTPS portal whose DNS answers are public passes both, exactly as before.
 */

import dns from 'node:dns'
import { SSRF_BLOCKED_HOSTS, isPrivateIp } from '../../config/urlRules.js'

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN =
  'https://hamilton-submit-fixture.invalid'

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST =
  new URL(CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN).hostname

function asHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

// WHATWG URL canonicalization renders a dotted IPv4-mapped IPv6 literal in hex
// (`[::ffff:127.0.0.1]` -> `::ffff:7f00:1`). urlRules.isPrivateIp only knows
// the dotted spelling, so translate the mapped 32 bits back before asking it.
function normalizedIpForPrivateCheck(host) {
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (!mapped) return host
  const high = Number.parseInt(mapped[1], 16)
  const low = Number.parseInt(mapped[2], 16)
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}

/** True for loopback, RFC1918, link-local, CGNAT, multicast and cloud-metadata addresses. */
export function isPrivateOrLocalHostname(hostname) {
  const h = asHostname(hostname)
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true
  if (SSRF_BLOCKED_HOSTS.has(h)) return true
  if (h === '::1' || h === '[::1]') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true
  // IP literals get the full urlRules range table (0.0.0.0/8, 100.64/10 CGNAT,
  // 198.18/15, multicast, IPv4-mapped IPv6, ...). Names are NOT passed to it:
  // isPrivateIp fails closed on non-IP strings, which would refuse every
  // public portal domain.
  if (isIpLiteral(h) && isPrivateIp(normalizedIpForPrivateCheck(h))) return true
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

// ── DNS-resolved SSRF gate ──────────────────────────────────────────────────

/** Default resolver: every A/AAAA answer, in the order the resolver returned. */
export function defaultBrowserTargetLookup(host) {
  return dns.promises.lookup(host, { all: true })
}

/**
 * Resolve a browser target's hostname and decide whether the browser may
 * connect. Returns `{ ok: true, addresses }` or `{ ok: false, reason }` with
 * one of:
 *   - `unsafe_target`           URL shape already fails the SSRF floor
 *   - `resolves_private:<ip>`   a public-looking NAME resolves to private space
 *   - `dns_rebinding:<host>`    a later answer set is not a subset of the first
 *                               pinned set for this host (rebinding attempt)
 *   - `dns_no_records`          the resolver returned nothing
 *   - `dns_error:<code>`        the lookup itself failed (NXDOMAIN, timeout, …)
 *
 * The reserved fixture and non-network URLs (about:blank, data:) are allowed
 * without a lookup; IP literals are decided by the range table alone.
 *
 * `pinnedAddresses` (Map<host, Set<ip>>) is per browser context: the first
 * answer set for a host is pinned and every later answer must be a subset of
 * it. `lookup` is injectable so the guard has a deterministic test.
 */
export async function resolvePublicBrowserTarget(value, { lookup = defaultBrowserTargetLookup, pinnedAddresses = null } = {}) {
  const raw = String(value || '')
  if (isControlledBetaSyntheticBrowserUrl(raw)) return { ok: true, addresses: [] }
  if (raw === 'about:blank' || raw.startsWith('data:')) return { ok: true, addresses: [] }
  const inner = raw.startsWith('blob:') ? raw.slice('blob:'.length) : raw
  if (!isHamiltonBrowserRequestAllowed(inner)) return { ok: false, reason: 'unsafe_target' }
  let host
  try { host = asHostname(new URL(inner).hostname) } catch { return { ok: false, reason: 'unsafe_target' } }
  if (!host) return { ok: false, reason: 'unsafe_target' }
  if (isIpLiteral(host)) {
    return isPrivateIp(normalizedIpForPrivateCheck(host))
      ? { ok: false, reason: `resolves_private:${host}` }
      : { ok: true, addresses: [host] }
  }
  let answers
  try {
    answers = await lookup(host)
  } catch (err) {
    return { ok: false, reason: `dns_error:${err?.code || err?.message || 'unknown'}` }
  }
  const addresses = [...new Set((Array.isArray(answers) ? answers : [answers])
    .map((a) => (typeof a === 'string' ? a : String(a?.address || '')))
    .filter(Boolean))]
  if (addresses.length === 0) return { ok: false, reason: 'dns_no_records' }
  for (const address of addresses) {
    if (isPrivateIp(address)) return { ok: false, reason: `resolves_private:${address}` }
  }
  if (pinnedAddresses) {
    const prior = pinnedAddresses.get(host)
    if (prior && addresses.some((address) => !prior.has(address))) {
      return { ok: false, reason: `dns_rebinding:${host}` }
    }
    if (!prior) pinnedAddresses.set(host, new Set(addresses))
  }
  return { ok: true, addresses }
}

/**
 * A DNS verdict that names a PRIVATE destination or a rebinding attempt is a
 * refusal wherever it is seen. A lookup FAILURE is not: the browser's own
 * resolver will fail the same navigation and the run reports an honest
 * `portal_unreachable`, so the launcher lets it through and the per-request
 * guard (which must decide) simply aborts that one request.
 */
export function isPrivateResolutionVerdict(verdict) {
  const reason = String(verdict?.reason || '')
  return reason === 'unsafe_target'
    || reason.startsWith('resolves_private:')
    || reason.startsWith('dns_rebinding:')
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

// Bound the per-request DNS cost: a verdict for a host is reused for this long
// inside one context before the host is re-resolved (and re-compared against
// its pinned answer set). Public portals load hundreds of subresources from a
// handful of hosts; one lookup per host per interval is enough to catch a
// rebinding attempt without a lookup per request.
export const EGRESS_GUARD_VERDICT_TTL_MS = 30_000

/**
 * Install before the first page/request. Aborts SSRF-class destinations while
 * allowing public portal hosts and the reserved synthetic fixture.
 *
 * Every http(s) request — including each redirect hop, popup, subresource and
 * fetch/XHR — is resolved through `resolvePublicBrowserTarget` before it may
 * continue, so a public-looking name that resolves to private space, or a
 * host whose answers change mid-session, is aborted at the route layer.
 * Non-network URLs (about:blank, data:) continue without a lookup.
 *
 * WebSockets bypass `context.route()`. When the context supports
 * `routeWebSocket`, a socket to a private/unsafe host is closed and every
 * other socket is connected straight through to its server.
 */
export async function installControlledBetaBrowserEgressGuard(context, { lookup = defaultBrowserTargetLookup, now = Date.now } = {}) {
  if (!context || typeof context.route !== 'function') {
    throw new Error('controlled_beta_browser_guard_unavailable')
  }
  const pinnedAddresses = new Map()
  const verdictCache = new Map()
  const resolveCached = async (requestUrl) => {
    let host = ''
    try { host = asHostname(new URL(requestUrl.startsWith('blob:') ? requestUrl.slice(5) : requestUrl).hostname) } catch { host = '' }
    const cached = host ? verdictCache.get(host) : null
    if (cached && cached.expiresAt > now()) return cached.verdict
    const verdict = await resolvePublicBrowserTarget(requestUrl, { lookup, pinnedAddresses })
    if (host) verdictCache.set(host, { verdict, expiresAt: now() + EGRESS_GUARD_VERDICT_TTL_MS })
    return verdict
  }
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', async (ws) => {
      let wsUrl = ''
      try { wsUrl = String(ws.url()) } catch { wsUrl = '' }
      // Compare on the http(s) form so the same host rules apply to ws(s).
      const httpForm = wsUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
      const verdict = httpForm ? await resolveCached(httpForm) : { ok: false, reason: 'unsafe_target' }
      if (verdict.ok) {
        // connectToServer without message handlers = transparent pass-through.
        ws.connectToServer()
        return
      }
      await ws.close()
    })
  }
  await context.route('**/*', async (route) => {
    let requestUrl = ''
    try { requestUrl = route.request().url() } catch { /* fail closed below */ }
    if (!isHamiltonBrowserRequestAllowed(requestUrl)) {
      await route.abort('blockedbyclient')
      return
    }
    const nonNetwork = requestUrl === 'about:blank' || requestUrl.startsWith('data:')
    const verdict = nonNetwork ? { ok: true } : await resolveCached(requestUrl)
    if (verdict.ok) {
      await route.continue()
      return
    }
    await route.abort('blockedbyclient')
  })
}

export function controlledBetaBrowserContextOptions(options = {}) {
  return { ...options, serviceWorkers: 'block' }
}
