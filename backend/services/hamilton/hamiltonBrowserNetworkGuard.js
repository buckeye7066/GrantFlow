/**
 * SSRF and origin confinement for Hamilton's portal browsers.
 *
 * Browser automation is more dangerous than a one-off fetch: the page can
 * navigate, create iframes, and issue subresource requests after profile data
 * has been filled. We therefore resolve and pin every reviewed origin before
 * launch, block service workers, and route only the exact pre-reviewed HTTPS
 * origins. Redirects and subresources pass through the same allowlist.
 */
import dns from 'node:dns'
import net from 'node:net'

import { assertSsrfSafeUrl, isPrivateIp } from '../../config/urlRules.js'

function parseHttpsOrigin(value) {
  let parsed
  try { parsed = new URL(String(value)) } catch { throw new Error('browser_target_url_invalid') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || (parsed.port && parsed.port !== '443')) throw new Error('browser_target_https_origin_required')
  return {
    parsed,
    origin: `https://${parsed.hostname.toLowerCase()}`,
    host: parsed.hostname.toLowerCase(),
  }
}

function normalizeLookupRecords(records) {
  const values = Array.isArray(records) ? records : records ? [records] : []
  return values.map((record) => typeof record === 'string' ? { address: record } : record)
    .filter((record) => record?.address)
}

function resolverRuleAddress(address) {
  return net.isIPv6(address) ? `[${address}]` : address
}

function normalizePathPrefix(value) {
  const raw = String(value || '').trim()
  if (!raw.startsWith('/') || raw.includes('?') || raw.includes('#')) {
    throw new Error('browser_path_prefix_invalid')
  }
  return raw.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
}

function pathMatchesPrefix(pathname, rawPrefix) {
  const path = normalizePathPrefix(pathname || '/')
  const prefix = normalizePathPrefix(rawPrefix)
  // Root is an exact path, never a wildcard. Treating `/` as a broad prefix
  // would let a same-origin redirect move a credential/profile mutation onto
  // any unreviewed route.
  if (prefix === '/') return path === '/'
  return path === prefix || path.startsWith(`${prefix}/`)
}

function uniquePathPrefixes(values = []) {
  return Object.freeze([...new Set(values.map(normalizePathPrefix))])
}

function adapterPathContract(target, submissionAdapter) {
  const application = uniquePathPrefixes(submissionAdapter.allowed_path_prefixes || [])
  const authentication = uniquePathPrefixes(submissionAdapter.auth_path_prefixes || [])
  const status = uniquePathPrefixes(submissionAdapter.status_query?.path_prefix
    ? [submissionAdapter.status_query.path_prefix]
    : [])
  const navigation = uniquePathPrefixes([...application, ...authentication, ...status])
  if (navigation.length === 0
      || !navigation.some((prefix) => pathMatchesPrefix(target.parsed.pathname, prefix))) {
    throw new Error('reviewed_adapter_target_path_not_allowed')
  }
  return Object.freeze({
    navigation,
    application,
    authentication,
    status,
    interactive: Object.freeze([]),
  })
}

function targetOnlyPathContract(target) {
  const exactTargetPrefix = normalizePathPrefix(target.parsed.pathname || '/')
  const one = Object.freeze([exactTargetPrefix])
  return Object.freeze({
    navigation: one,
    application: one,
    authentication: one,
    status: one,
    interactive: one,
  })
}

function extendNavigationPathContract(contract, values = []) {
  const extra = uniquePathPrefixes(values)
  if (extra.length === 0) return contract
  return Object.freeze({
    ...contract,
    // Navigation permission is intentionally distinct from every mutation
    // group. A read-only session probe may observe a known sign-in redirect
    // without gaining permission to type credentials or profile answers there.
    navigation: uniquePathPrefixes([...(contract.navigation || []), ...extra]),
  })
}

export async function prepareHamiltonBrowserEgress({
  targetUrl,
  submissionAdapter = null,
  additionalAllowedOrigins = [],
  additionalNavigationPathPrefixes = [],
  ssrfCheck = assertSsrfSafeUrl,
  lookup = (host, options) => dns.promises.lookup(host, options),
} = {}) {
  const target = parseHttpsOrigin(targetUrl)
  if (submissionAdapter) {
    if (target.host !== String(submissionAdapter.portal_host || '').toLowerCase()) {
      throw new Error('reviewed_adapter_origin_mismatch')
    }
  }
  const adapterOrigins = submissionAdapter?.allowed_origins || []
  const allowedOrigins = [...new Set([
    target.origin,
    ...adapterOrigins,
    ...additionalAllowedOrigins,
  ].map((origin) => parseHttpsOrigin(origin).origin))]
  if (submissionAdapter && !adapterOrigins.map(String).includes(target.origin)) {
    throw new Error('reviewed_adapter_target_origin_not_allowed')
  }
  const basePathContract = submissionAdapter
    ? adapterPathContract(target, submissionAdapter)
    : targetOnlyPathContract(target)
  const path_contract = extendNavigationPathContract(
    basePathContract,
    additionalNavigationPathPrefixes,
  )

  const pinnedHosts = {}
  for (const origin of allowedOrigins) {
    const { host } = parseHttpsOrigin(origin)
    const ssrf = await ssrfCheck(`${origin}/`)
    if (!ssrf?.ok) throw new Error(`browser_ssrf_blocked:${String(ssrf?.reason || 'unknown').slice(0, 120)}`)
    let records
    if (net.isIP(host)) records = [{ address: host }]
    else records = normalizeLookupRecords(await lookup(host, { all: true, verbatim: true }))
    if (records.length === 0) throw new Error('browser_dns_no_records')
    if (records.some((record) => isPrivateIp(record.address))) throw new Error('browser_dns_private_address')
    const selected = records.find((record) => net.isIPv4(record.address)) || records[0]
    pinnedHosts[host] = selected.address
  }

  const hostResolverRules = Object.entries(pinnedHosts)
    .map(([host, address]) => `MAP ${host} ${resolverRuleAddress(address)}`)
    .concat('MAP * ~NOTFOUND')
    .join(',')
  return Object.freeze({
    target_origin: target.origin,
    allowed_origins: Object.freeze(allowedOrigins),
    pinned_hosts: Object.freeze({ ...pinnedHosts }),
    path_contract,
    extra_args: Object.freeze([`--host-resolver-rules=${hostResolverRules}`]),
    context_options: Object.freeze({ serviceWorkers: 'block' }),
  })
}

export function hamiltonBrowserUrlAllowed(egress, value) {
  if (!egress) return false
  let parsed
  try { parsed = parseHttpsOrigin(value) } catch { return false }
  return egress.allowed_origins.includes(parsed.origin)
    && Object.hasOwn(egress.pinned_hosts, parsed.host)
}

export function hamiltonBrowserNavigationAllowed(egress, value) {
  if (!hamiltonBrowserUrlAllowed(egress, value)) return false
  let parsed
  try { parsed = new URL(String(value)) } catch { return false }
  return (egress.path_contract?.navigation || [])
    .some((prefix) => pathMatchesPrefix(parsed.pathname, prefix))
}

export function hamiltonBrowserActionAllowed(egress, value, action = 'application') {
  if (!hamiltonBrowserUrlAllowed(egress, value)) return false
  let parsed
  try { parsed = new URL(String(value)) } catch { return false }
  const group = action === 'credential' ? 'authentication'
    : action === 'status' ? 'status'
      : action === 'human_input' ? 'interactive'
        : 'application'
  return (egress.path_contract?.[group] || [])
    .some((prefix) => pathMatchesPrefix(parsed.pathname, prefix))
}

export async function installHamiltonBrowserNetworkGuard(context, egress) {
  if (!context || !egress) throw new Error('browser_network_guard_required')
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = request.url()
    const navigation = typeof request.isNavigationRequest === 'function'
      ? request.isNavigationRequest()
      : typeof request.resourceType === 'function' && request.resourceType() === 'document'
    if (!hamiltonBrowserUrlAllowed(egress, url)
        || (navigation && !hamiltonBrowserNavigationAllowed(egress, url))) {
      await Promise.resolve(route.abort('blockedbyclient')).catch(() => {})
      return
    }
    await route.continue()
  })
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket(/.*/, async (socket) => {
      let allowed = false
      try {
        const parsed = new URL(socket.url())
        const httpsEquivalent = parsed.protocol === 'wss:'
          ? `https://${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`
          : null
        allowed = Boolean(httpsEquivalent && (!parsed.port || parsed.port === '443')
          && !parsed.username && !parsed.password
          && hamiltonBrowserUrlAllowed(egress, httpsEquivalent))
      } catch { allowed = false }
      if (!allowed) {
        await Promise.resolve(socket.close({ code: 1008, reason: 'blocked by Hamilton origin policy' })).catch(() => {})
        return
      }
      socket.connectToServer()
    })
  }
  return egress
}

export function assertHamiltonLivePageAllowed(page, egress) {
  const url = (() => { try { return page.url() } catch { return null } })()
  if (!hamiltonBrowserNavigationAllowed(egress, url)) throw new Error('browser_live_navigation_changed')
  return url
}

export function assertHamiltonActionPageAllowed(page, egress, action = 'application') {
  const url = (() => { try { return page.url() } catch { return null } })()
  if (!hamiltonBrowserActionAllowed(egress, url, action)) {
    throw new Error(`browser_live_${action}_path_not_allowed`)
  }
  return url
}

export async function runHamiltonPageAction(page, egress, action, operation) {
  if (typeof operation !== 'function') throw new Error('browser_action_operation_required')
  assertHamiltonActionPageAllowed(page, egress, action)
  return operation()
}

export async function navigateHamiltonPortalPage(page, targetUrl, egress, options = {}) {
  if (!page || !hamiltonBrowserNavigationAllowed(egress, targetUrl)) {
    throw new Error('browser_navigation_target_not_allowed')
  }
  const response = await page.goto(targetUrl, options)
  assertHamiltonLivePageAllowed(page, egress)
  return response
}

export const _internal = {
  parseHttpsOrigin, normalizeLookupRecords, resolverRuleAddress,
  normalizePathPrefix, pathMatchesPrefix, adapterPathContract, targetOnlyPathContract,
  extendNavigationPathContract,
}
