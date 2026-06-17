/**
 * agentAdapterRegistry.js
 *
 * Single source of truth for adapter lookup. The orchestrator never
 * imports adapters directly — it asks the registry for a name, so a
 * future adapter swap (mock for tests, alternate implementation for an
 * agent rewrite) only changes one file.
 *
 * Pluggable: tests can call `setAdapter('sam', mockAdapter)` to replace
 * a real adapter for the duration of a test, then `resetRegistry()` to
 * restore defaults.
 */

import { SamAgentAdapter } from './samAgentAdapter.js'
import { RobertAgentAdapter } from './robertAgentAdapter.js'
import { YanaAgentAdapter } from './yanaAgentAdapter.js'
import { JohnAgentAdapter } from './johnAgentAdapter.js'
import { HamiltonAgentAdapter } from './hamiltonAgentAdapter.js'

let adapters = null

function buildDefaultAdapters() {
  return {
    sam: new SamAgentAdapter(),
    robert: new RobertAgentAdapter(),
    yana: new YanaAgentAdapter(),
    john: new JohnAgentAdapter(),
    hamilton: new HamiltonAgentAdapter(),
  }
}

export function getAdapter(name) {
  if (!adapters) adapters = buildDefaultAdapters()
  const key = String(name || '').toLowerCase()
  return adapters[key] || null
}

export function listAdapters() {
  if (!adapters) adapters = buildDefaultAdapters()
  return { ...adapters }
}

/**
 * Replace one adapter (used by tests). Returns the previous adapter so
 * the test can restore it on teardown.
 */
export function setAdapter(name, adapter) {
  if (!adapters) adapters = buildDefaultAdapters()
  const key = String(name || '').toLowerCase()
  const prev = adapters[key]
  adapters[key] = adapter
  return prev
}

export function resetRegistry() {
  adapters = null
}
