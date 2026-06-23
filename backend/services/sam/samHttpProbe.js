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

/**
 * @param {object} [opts]
 * @param {string} [opts.host]          loopback base URL (defaults to 127.0.0.1:PORT)
 * @param {string} [opts.adminToken]    admin service token (defaults to env)
 * @param {string} [opts.forwardedAuth] optional Authorization header to forward
 * @returns {null | (({method,path}) => Promise<{status:number, body:any}>)}
 */
export function makeInternalHttpProbe(opts = {}) {
  if (typeof fetch !== 'function') return null
  const host = opts.host || `http://127.0.0.1:${process.env.PORT || 3911}`
  const adminToken =
    opts.adminToken ?? (process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null)
  const forwardedAuth = opts.forwardedAuth || null

  return async ({ method, path }) => {
    try {
      const headers = { 'x-sam-internal': 'true' }
      if (adminToken) headers['x-admin-token'] = adminToken
      if (forwardedAuth) headers.authorization = forwardedAuth
      const resp = await fetch(`${host}${path}`, { method, headers })
      let body
      try {
        body = await resp.json()
      } catch {
        body = await resp.text()
      }
      return { status: resp.status, body }
    } catch (err) {
      return { status: 0, body: String(err?.message || err) }
    }
  }
}

export default { makeInternalHttpProbe }
