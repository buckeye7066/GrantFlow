/**
 * Hamilton browser policy.
 *
 * Hamilton drives real public HTTPS portals when automation is enabled.
 * The SSRF floor remains: private/loopback/link-local IP ranges and known
 * metadata service hostnames are always blocked — these are infrastructure
 * concerns, not user-facing blockers.
 *
 * The reserved synthetic fixture origin is retained for unit tests that need
 * a controllable in-process HTTP target.
 */

import { isPrivateIp } from '../../config/urlRules.js'
import dns from 'node:dns/promises'

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN =
  'https://hamilton-submit-fixture.invalid'

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST =
  new URL(CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN).hostname

// Known metadata / loopback hostnames that must never be reached by a
// portal browser even if they appear in a redirect chain.
const SSRF_BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
])

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

/**
 * Is this URL safe for a Hamilton browser context to request?
 * Allows any HTTPS URL whose hostname is not a private/loopback/metadata address.
 * Blocks HTTP (non-TLS), private IPs, and known metadata service hostnames.
 */
export function isPublicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!host) return false
    if (SSRF_BLOCKED_HOSTNAMES.has(host)) return false
    const isIpLiteral = /^[0-9.]+$/.test(host) || host.includes(':')
    if (isIpLiteral) return !isPrivateIp(host)
    return true
  } catch {
    return false
  }
}

/** Resolve every A/AAAA answer before browser egress.  The optional resolver is
 * deliberately injectable so the SSRF/rebinding floor has a deterministic
 * guard test.  A second answer for a host must be a subset of the first pinned
 * answer; otherwise the request is refused as DNS rebinding. */
export async function resolvePublicHttpsUrl(value, { lookup = dns.lookup, pinnedAddresses = null } = {}) {
  if (isControlledBetaSyntheticBrowserUrl(value)) return true
  if (!isPublicHttpsUrl(value)) return false
  const host = new URL(String(value)).hostname.toLowerCase()
  const isIpLiteral = /^[0-9.]+$/.test(host) || host.includes(':')
  if (isIpLiteral) return !isPrivateIp(host)
  let answers
  try {
    answers = await lookup(host, { all: true, verbatim: true })
  } catch {
    return false
  }
  const addresses = [...new Set((answers || []).map((answer) => String(answer?.address || '')))].filter(Boolean)
  if (addresses.length === 0 || addresses.some((address) => isPrivateIp(address))) return false
  if (pinnedAddresses) {
    const prior = pinnedAddresses.get(host)
    if (prior && addresses.some((address) => !prior.has(address))) return false
    if (!prior) pinnedAddresses.set(host, new Set(addresses))
  }
  return true
}

/** Non-network document URLs and any public HTTPS URL are allowed. */
export function isControlledBetaBrowserRequestAllowed(value) {
  const raw = String(value || '')
  if (raw === 'about:blank' || raw.startsWith('data:')) return true
  if (raw.startsWith('blob:')) {
    const inner = raw.slice('blob:'.length)
    return isControlledBetaSyntheticBrowserUrl(inner) || isPublicHttpsUrl(inner)
  }
  return isControlledBetaSyntheticBrowserUrl(raw) || isPublicHttpsUrl(raw)
}

/** SSRF refusal — returned when a private/loopback/metadata target is blocked. */
export function controlledBetaBrowserRefusal() {
  return {
    code: 'ssrf_blocked',
    message: 'Hamilton does not open private, loopback, or metadata-service addresses in a browser.',
  }
}

/**
 * Install before the first page/request. Playwright routing covers redirects,
 * popup/new-tab requests, subresources, and fetch/XHR. Blocking service workers
 * on context creation keeps them from bypassing the route handler.
 * Blocks only SSRF-dangerous targets (private IPs, HTTP, metadata services);
 * all public HTTPS requests continue normally.
 */
export async function installControlledBetaBrowserEgressGuard(context) {
  if (!context || typeof context.route !== 'function') {
    throw new Error('controlled_beta_browser_guard_unavailable')
  }
  const pinnedAddresses = new Map()
  await context.route('**/*', async (route) => {
    let requestUrl = ''
    try { requestUrl = route.request().url() } catch { /* fail closed below */ }
    const nonNetworkUrl = requestUrl === 'about:blank' || requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')
    if (nonNetworkUrl || await resolvePublicHttpsUrl(requestUrl, { pinnedAddresses })) {
      await route.continue()
      return
    }
    await route.abort('blockedbyclient')
  })
}

export function controlledBetaBrowserContextOptions(options = {}) {
  return { ...options, serviceWorkers: 'block' }
}
