export async function prepareSyntheticHamiltonEgress({
  targetUrl,
  additionalNavigationPathPrefixes = [],
} = {}) {
  const parsed = new URL(String(targetUrl))
  const origin = parsed.origin
  const host = parsed.hostname.toLowerCase()
  const pathPrefix = parsed.pathname.replace(/\/+$/, '') || '/'
  const paths = Object.freeze([pathPrefix])
  const navigationPaths = Object.freeze([...new Set([
    pathPrefix,
    ...additionalNavigationPathPrefixes.map((value) => String(value).replace(/\/+$/, '') || '/'),
  ])])
  return Object.freeze({
    target_origin: origin,
    allowed_origins: Object.freeze([origin]),
    pinned_hosts: Object.freeze({ [host]: '93.184.216.34' }),
    path_contract: Object.freeze({
      navigation: navigationPaths,
      application: paths,
      authentication: paths,
      status: paths,
      interactive: paths,
    }),
    extra_args: Object.freeze([`--host-resolver-rules=MAP ${host} 93.184.216.34,MAP * ~NOTFOUND`]),
    context_options: Object.freeze({ serviceWorkers: 'block' }),
  })
}

export function addSyntheticHamiltonNetworkSurface(context) {
  if (!context) return context
  if (typeof context.route !== 'function') context.route = async () => {}
  if (typeof context.routeWebSocket !== 'function') context.routeWebSocket = async () => {}
  return context
}
