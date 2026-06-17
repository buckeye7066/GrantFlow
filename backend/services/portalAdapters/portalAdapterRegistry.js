/**
 * portalAdapterRegistry.js
 *
 * Central registry that maps portal types to adapters. Yana imports this
 * module to find the right adapter for any (portalLink, opportunity)
 * pair. Tests can register fixture adapters via `registerPortalAdapter`.
 */

import { manualPortalAdapter } from './manualPortalAdapter.js'
import { externalApplicationAdapter } from './externalApplicationAdapter.js'
import { universityFinancialAidAdapter } from './universityFinancialAidAdapter.js'
import { scholarshipPortalAdapter } from './scholarshipPortalAdapter.js'

const adapters = []

function registerInternal(adapter) {
  if (!adapter || typeof adapter.canHandle !== 'function') return
  adapters.push(adapter)
}

// Order matters — earlier adapters win when canHandle() returns true. We
// list specific adapters before the manual fallback.
registerInternal(externalApplicationAdapter)
registerInternal(universityFinancialAidAdapter)
registerInternal(scholarshipPortalAdapter)
registerInternal(manualPortalAdapter)

export function listPortalAdapters() {
  return adapters.slice()
}

export function registerPortalAdapter(adapter) {
  if (!adapter || typeof adapter.canHandle !== 'function') {
    throw new Error('registerPortalAdapter: adapter must implement canHandle()')
  }
  adapters.unshift(adapter) // user-registered adapters take priority
}

export function resolveAdapter(portalLink, opportunity = null, profile = null) {
  if (!portalLink) return manualPortalAdapter
  for (const adapter of adapters) {
    try {
      if (adapter.canHandle(portalLink, opportunity, profile)) return adapter
    } catch {
      // ignore broken canHandle implementations
    }
  }
  return manualPortalAdapter
}

export function _resetForTests() {
  // Tests may want to remove user-registered adapters. We rebuild the
  // built-in stack from scratch.
  adapters.length = 0
  registerInternal(externalApplicationAdapter)
  registerInternal(universityFinancialAidAdapter)
  registerInternal(scholarshipPortalAdapter)
  registerInternal(manualPortalAdapter)
}

export {
  manualPortalAdapter,
  externalApplicationAdapter,
  universityFinancialAidAdapter,
  scholarshipPortalAdapter,
}
