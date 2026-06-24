/**
 * Shared internal HTTP probe for Sam's diagnostics.
 *
 * Sam's HTTP-class checks (readyz, health, agent-control status, Hamilton
 * routes, comms surface) need an in-process loopback fetch with trusted admin
 * credentials. The /api/sam ROUTE built this from the request; the SCHEDULER
 * and the agent-control ADAPTER passed nothing, so autonomous Sam silently
 * fail-skipped ~13 checks while still reporting a green health score (the
 * 2026-06-23 audit's "green while not actually checking" defect). This helper
 * gives every entry point the same credentialed loopback probe.
 *
 * The probe ONLY ever targets loopback (127.0.0.1:PORT) and only sends the
 * server's own ADMIN_TOKEN, so credentials never leave the box.
 */

// Per-probe hard timeout. Node's global fetch has NO default timeout, so a
// loopback request to a port that isn't accepting connections (or an endpoint
// that hangs) would block Sam indefinitely — and because Sam's preflight gates
// the whole Agent-Control cycle, one hung probe stalls EVERY downstream agent
// (Robert/Yana/John/Hamilton stay queued forever). The 2026-06-23 full-cycle
// audit hit exactly this: with PORT=0 (no listener) the cycle never finished.
// A bounded timeout converts a hang into an honest {status:0} skip.
const PROBE_TIMEOUT_MS = Number(process.env.SAM_HTTP_PROBE_TIMEOUT_MS) || 8000

// Resolve the loopback port. When there is no real listening server (PORT
// unset, '0', or non-numeric — e.g. test/CI/SMOKE boots that disable the HTTP
// listener), there is nothing to probe: return null so Sam honestly fail-skips
// its HTTP-class checks (classified INFO by isRuntimeUnavailableError) instead
// of waiting out a timeout on every check.
function resolveLoopbackPort() {
  const raw = process.env.PORT
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return null
  return n
}

/**
 * @param {object} [opts]
 * @param {string} [opts.host]          loopback base URL (defaults to 127.0.0.1:PORT)
 * @param {string} [opts.adminToken]    admin service token (defaults to env)
 * @param {string} [opts.forwardedAuth] optional Authorization header to forward
 * @returns {null | (({method,path}) => Promise<{status:number, body:any}>)}
 */
export function makeInternalHttpProbe(opts = {}) {
  if (typeof fetch !== 'function') return null
  let host = opts.host
  if (!host) {
    const port = resolveLoopbackPort()
    if (!port) return null // no listening server → nothing to probe (no hang)
    host = `http://127.0.0.1:${port}`
  }
  const adminToken =
    opts.adminToken ?? (process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null)
  const forwardedAuth = opts.forwardedAuth || null

  return async ({ method, path }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const headers = { 'x-sam-internal': 'true' }
      if (adminToken) headers['x-admin-token'] = adminToken
      if (forwardedAuth) headers.authorization = forwardedAuth
      const resp = await fetch(`${host}${path}`, { method, headers, signal: controller.signal })
      let body
      try {
        body = await resp.json()
      } catch {
        body = await resp.text()
      }
      return { status: resp.status, body }
    } catch (err) {
      // Aborted timeout or connection error → honest "unavailable" signal.
      return { status: 0, body: String(err?.name === 'AbortError' ? `probe_timeout_${PROBE_TIMEOUT_MS}ms` : (err?.message || err)) }
    } finally {
      clearTimeout(timer)
    }
  }
}

export default { makeInternalHttpProbe }
