function normalizeAppBasePath(appBasePath) {
  const value = String(appBasePath || '/').replace(/^\/+|\/+$/g, '')
  return value ? `/${value}` : '/'
}

/**
 * Pick the static HTML document for a SPA request.
 *
 * Public acquisition and legal routes need their own crawlable source head;
 * every other route receives the protected noindex shell. The legacy
 * /grantflow prefix is still accepted when the current deployment is mounted
 * at the host root so a proxy that misses the canonical redirect cannot serve
 * the protected shell for a public URL.
 */
export function spaEntryDocument(requestPath, appBasePath = '/') {
  const normalizedBase = normalizeAppBasePath(appBasePath)
  let routePath = String(requestPath || '/').replace(/\/+$/, '') || '/'

  if (
    normalizedBase !== '/' &&
    (routePath === normalizedBase || routePath.startsWith(`${normalizedBase}/`))
  ) {
    routePath = routePath.slice(normalizedBase.length) || '/'
  } else if (
    normalizedBase === '/' &&
    routePath.toLowerCase().startsWith('/grantflow/')
  ) {
    routePath = routePath.slice('/grantflow'.length) || '/'
  }

  if (routePath.toLowerCase() === '/welcome') return 'welcome.html'
  if (routePath.toLowerCase() === '/privacy') return 'privacy.html'
  return 'index.html'
}

