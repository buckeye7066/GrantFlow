/**
 * portalSync/registry.js
 *
 * The catalogue of portal connectors. Add a connector here and it is
 * automatically reachable by runPortalSync. Resolution is by host: the first
 * connector whose `hostMatch` RegExp matches the (normalized) host wins.
 */

import { normalizeHost } from '../hamiltonCredentialSessionService.js'
import mtsu from './connectors/mtsu.js'

// Order matters only for overlapping host patterns; keep most-specific first.
const CONNECTORS = Object.freeze([mtsu])

/** @returns {import('./types.js').PortalConnector[]} shallow copy of the registry. */
export function listConnectors() {
  return CONNECTORS.map((c) => ({ id: c.id, label: c.label, hostMatch: c.hostMatch }))
}

/**
 * Resolve the connector that drives a given host (or full URL). Returns the live
 * connector object (with read/write), or null when none matches.
 * @param {string} host hostname or URL
 * @returns {import('./types.js').PortalConnector|null}
 */
export function getConnectorForHost(host) {
  const h = normalizeHost(host)
  if (!h) return null
  return CONNECTORS.find((c) => {
    try { return c.hostMatch instanceof RegExp && c.hostMatch.test(h) } catch { return false }
  }) || null
}

export default { listConnectors, getConnectorForHost }
