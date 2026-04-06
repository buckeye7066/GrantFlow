/**
 * Detects when the browser URL is missing the app basename (VITE_APP_BASE)
 * and immediately redirects to the correct basename-prefixed path.
 *
 * This handles stale bookmarks, external links, notification emails, and
 * SPA fallback servers that serve index.html for bare paths like
 * /GrantDetail?id=... when the correct URL is /grantflow/GrantDetail?id=...
 *
 * Call this before ReactDOM.createRoot so the redirect happens before React
 * Router ever tries to match routes.
 */
export function enforceBasename() {
  const raw = String(import.meta.env.VITE_APP_BASE || import.meta.env.BASE_URL || '').trim()
  if (!raw || raw === '/') return

  // Normalize: no trailing slash, must start with /
  const basename = raw.endsWith('/') ? raw.slice(0, -1) : raw

  const { pathname, search, hash } = window.location
  if (pathname.startsWith(basename)) return

  // The URL is missing the basename — redirect to the correct path
  window.location.replace(`${basename}${pathname}${search}${hash}`)
}
