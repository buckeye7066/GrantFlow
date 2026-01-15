export function enforceCanonicalHost() {
  // Production-only canonical host enforcement to keep customers on one URL.
  // This is intentionally non-fatal and only redirects when explicitly configured.
  if (!import.meta.env.PROD) return

  const canonicalHost = String(import.meta.env.VITE_CANONICAL_HOST || '').trim()
  if (!canonicalHost) return

  const currentHost = window.location.host
  if (!currentHost || currentHost === canonicalHost) return

  const canonicalOrigin = `${window.location.protocol}//${canonicalHost}`
  const target = `${canonicalOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.replace(target)
}

