/**
 * portalBrowserAdapterRegistry.js
 *
 * Resolves the correct browser adapter for a given portal link. The
 * order matters — more specific adapters first, with the manual
 * adapter as a guaranteed fallback so the orchestrator always has
 * something to talk to.
 */

import { basePortalBrowserAdapter } from './basePortalBrowserAdapter.js'
import { genericScholarshipPortalAdapter } from './genericScholarshipPortalAdapter.js'
import { genericUniversityFinancialAidAdapter } from './genericUniversityFinancialAidAdapter.js'
import { genericAdmissionsPortalAdapter } from './genericAdmissionsPortalAdapter.js'
import { manualPortalAdapter } from './manualPortalAdapter.js'

const REGISTRY = Object.freeze([
  genericUniversityFinancialAidAdapter,
  genericScholarshipPortalAdapter,
  genericAdmissionsPortalAdapter,
  manualPortalAdapter,
])

export function resolveBrowserAdapter(portalLink, opportunity = null, profile = null) {
  for (const adapter of REGISTRY) {
    try {
      if (adapter.canHandle(portalLink, opportunity, profile)) return adapter
    } catch { /* ignore — try the next adapter */ }
  }
  // No specific adapter claimed the portal. Use the scholarship adapter
  // as the default supervised flow rather than the manual adapter —
  // manual is reserved for explicit manual_or_offline links.
  return genericScholarshipPortalAdapter
}

export const _internal = { REGISTRY, basePortalBrowserAdapter }
