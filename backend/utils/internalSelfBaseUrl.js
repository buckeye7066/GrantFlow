import net from 'node:net'

function normalizeHostname(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

function isLoopbackHost(hostname) {
  const host = normalizeHostname(hostname)
  if (host === 'localhost' || host === '::1') return true
  if (net.isIP(host) !== 4) return false
  return host.startsWith('127.')
}

/**
 * Resolve the backend's own origin without consulting request Host headers.
 * Credentials are forwarded to this origin, so request-controlled authority is
 * never acceptable. The origin is loopback-only; public self-calls would make
 * an environment typo sufficient to exfiltrate bearer tokens or cookies.
 */
export function resolveInternalSelfBaseUrl({
  configured = process.env.ANYA_SELF_BASE_URL,
  port = process.env.PORT || 8080,
} = {}) {
  const configuredValue = String(configured || '').trim()
  const candidate = configuredValue || `http://127.0.0.1:${String(port ?? '').trim()}`

  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, baseUrl: null, reason: 'invalid_internal_base_url' }
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, baseUrl: null, reason: 'invalid_internal_base_url' }
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    return { ok: false, baseUrl: null, reason: 'internal_base_path_not_allowed' }
  }

  const loopback = isLoopbackHost(parsed.hostname)
  if (!loopback) {
    return { ok: false, baseUrl: null, reason: 'internal_base_must_be_loopback' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, baseUrl: null, reason: 'invalid_internal_base_protocol' }
  }

  const resolvedPort = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65_535) {
    return { ok: false, baseUrl: null, reason: 'invalid_internal_base_port' }
  }

  // Avoid resolving the localhost label for a credential-bearing request.
  if (normalizeHostname(parsed.hostname) === 'localhost') parsed.hostname = '127.0.0.1'

  return {
    ok: true,
    baseUrl: parsed.origin,
    reason: null,
    source: configuredValue ? 'configured' : 'loopback_default',
  }
}

export default { resolveInternalSelfBaseUrl }
