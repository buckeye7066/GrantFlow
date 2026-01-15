export function enforceCanonicalHost() {
  // Production-only canonical host enforcement to keep customers on one URL.
  // This is intentionally non-fatal and only redirects when explicitly enabled.
  if (!import.meta.env.PROD) return

  const canonicalHost = String(import.meta.env.VITE_CANONICAL_HOST || '').trim()
  if (!canonicalHost) return

  // Opt-in strict mode so deployments can be stabilized before DNS cutover is complete.
  // Set: VITE_CANONICAL_HOST_STRICT=true
  const strict = String(import.meta.env.VITE_CANONICAL_HOST_STRICT || '').toLowerCase() === 'true'
  if (!strict) return

  const currentHost = window.location.host
  if (!currentHost || currentHost === canonicalHost) return

  const canonicalOrigin = `${window.location.protocol}//${canonicalHost}`
  const target = `${canonicalOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.replace(target)
}

