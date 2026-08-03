/**
 * portalSync/registry.js
 *
 * The catalogue of portal connectors. Add a connector here and it is
 * automatically reachable by runPortalSync.
 *
 * Resolution is credential-aware, not host-only. Many schools sit behind a
 * shared IdP (e.g. an MTSU account logs in at login.microsoftonline.com), so a
 * connector can claim a credential by host AND/OR by the account's email/label
 * via an optional `matchesCredential({ host, username, label })`. When no
 * specific connector claims it, a GENERIC connector handles any host so every
 * saved login/session is still connectable — Hamilton signs in (proving access)
 * and reports honestly that there's no structured field mapping for that portal
 * yet. Hamilton always owns the URL: the user only supplies username/password/2FA.
 */

import { normalizeHost } from '../hamiltonCredentialSessionService.js'
import mtsu from './connectors/mtsu.js'
import studentaid from './connectors/studentaid.js'
import ngwebScholarshipManager from './connectors/ngwebScholarshipManager.js'
import genericConnector from './connectors/generic.js'

// Specific connectors. Order matters only for overlapping patterns; keep
// most-specific first. The generic fallback is intentionally NOT in this list.
//
// ngwebScholarshipManager MUST stay ahead of mtsu: mtsu.matchesCredential
// claims ANY credential whose username/label says "mtsu" regardless of host,
// so a credential saved for mtsu.scholarships.ngwebsolutions.com labelled
// "MTSU Scholarships" would otherwise route to the mtsu.edu connector (which
// navigates pipelinemt.mtsu.edu, the wrong portal entirely).
const CONNECTORS = Object.freeze([ngwebScholarshipManager, mtsu, studentaid])

/** @returns user-facing list of the real (non-generic) connectors. */
export function listConnectors() {
  return CONNECTORS.map((c) => ({ id: c.id, label: c.label, hostMatch: String(c.hostMatch) }))
}

function hostMatches(connector, h) {
  try { return connector.hostMatch instanceof RegExp && connector.hostMatch.test(h) } catch { return false }
}

/**
 * Resolve the connector for a host alone (no credential context). Returns a
 * specific connector when its hostMatch matches, otherwise the GENERIC
 * connector — never null, so any reachable host is syncable.
 * @param {string} host hostname or URL
 * @returns {import('./types.js').PortalConnector}
 */
export function getConnectorForHost(host) {
  const h = normalizeHost(host)
  if (!h) return genericConnector
  return CONNECTORS.find((c) => hostMatches(c, h)) || genericConnector
}

/**
 * Credential-aware resolution. Prefer a specific connector that claims the
 * credential (by host OR by email/label), so an MTSU login stored under
 * login.microsoftonline.com still routes to the MTSU connector. Falls back to
 * host match, then the generic connector.
 * @param {{ host?:string, username?:string, label?:string }} ctx
 * @returns {import('./types.js').PortalConnector}
 */
export function resolveConnector({ host, username = null, label = null } = {}) {
  const h = normalizeHost(host)
  // 1. A specific connector that explicitly claims this credential.
  for (const c of CONNECTORS) {
    try {
      if (typeof c.matchesCredential === 'function' && c.matchesCredential({ host: h, username, label })) return c
    } catch { /* a connector's matcher must never break resolution */ }
  }
  // 2. Host pattern match.
  if (h) {
    const byHost = CONNECTORS.find((c) => hostMatches(c, h))
    if (byHost) return byHost
  }
  // 3. Generic fallback.
  return genericConnector
}

export default { listConnectors, getConnectorForHost, resolveConnector }
