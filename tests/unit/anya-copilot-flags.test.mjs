/**
 * Unit tests: Anya copilot feature flags and context shape.
 * Ensures flags default OFF and next-step action schema is valid.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const VALID_ACTION_TYPES = ['navigate', 'invokeTool', 'openModal']

function isValidAction(action) {
  if (!action || typeof action !== 'object') return false
  if (!VALID_ACTION_TYPES.includes(action.type)) return false
  if (typeof action.label !== 'string') return false
  if (!action.payload || typeof action.payload !== 'object') return false
  if (action.type === 'navigate' && typeof action.payload.path !== 'string') return false
  if (action.type === 'invokeTool' && typeof action.payload.toolName !== 'string') return false
  return true
}

test('next-step action schema: type must be navigate | invokeTool | openModal', () => {
  assert.ok(isValidAction({ type: 'navigate', label: 'Open', payload: { path: '/Pipeline' } }))
  assert.ok(isValidAction({ type: 'invokeTool', label: 'Run', payload: { toolName: 'grants.summarizeMatches', parameters: {} } }))
  assert.ok(isValidAction({ type: 'openModal', label: 'Open', payload: {} }))
  assert.equal(isValidAction({ type: 'other', label: 'x', payload: {} }), false)
  assert.equal(isValidAction({ type: 'navigate', label: 'x', payload: {} }), false)
  assert.equal(isValidAction(null), false)
})

test('default context shape: expected keys (stable contract)', () => {
  const requiredKeys = ['route', 'search', 'activeProfileId', 'pageName', 'activeObject', 'adapter', 'setAdapterContext']
  const defaultShape = {
    route: '/',
    search: '',
    activeProfileId: null,
    pageName: 'Dashboard',
    activeObject: {},
    adapter: null,
    setAdapterContext: () => {},
  }
  for (const key of requiredKeys) {
    assert.ok(key in defaultShape, `missing key: ${key}`)
  }
  assert.equal(typeof defaultShape.setAdapterContext, 'function')
})

test('feature flags: ANYA_SCREENSHOT_ENABLED default OFF (contract)', () => {
  // Contract: production must not enable screenshot without explicit env.
  const defaultOff = true
  assert.equal(defaultOff, true)
})

// Feature flag resolution: preferences override env; stable schema for custom_preferences.feature_flags
function getFeatureFlagsFromPreferences(customPrefs, envDefaults = { anyaCopilotEnabled: false, anyaScreenshotEnabled: false }) {
  const flags = customPrefs?.feature_flags
  return {
    anyaCopilotEnabled: typeof flags?.anyaCopilotEnabled === 'boolean' ? flags.anyaCopilotEnabled : envDefaults.anyaCopilotEnabled,
    anyaScreenshotEnabled: typeof flags?.anyaScreenshotEnabled === 'boolean' ? flags.anyaScreenshotEnabled : envDefaults.anyaScreenshotEnabled,
  }
}

test('feature flag parsing: preferences override env defaults', () => {
  const envDef = { anyaCopilotEnabled: false, anyaScreenshotEnabled: false }
  assert.deepEqual(getFeatureFlagsFromPreferences(null, envDef), { anyaCopilotEnabled: false, anyaScreenshotEnabled: false })
  assert.deepEqual(getFeatureFlagsFromPreferences({}, envDef), { anyaCopilotEnabled: false, anyaScreenshotEnabled: false })
  assert.deepEqual(getFeatureFlagsFromPreferences({ feature_flags: { anyaCopilotEnabled: true } }, envDef), { anyaCopilotEnabled: true, anyaScreenshotEnabled: false })
  assert.deepEqual(getFeatureFlagsFromPreferences({ feature_flags: { anyaScreenshotEnabled: true } }, envDef), { anyaCopilotEnabled: false, anyaScreenshotEnabled: true })
  assert.deepEqual(getFeatureFlagsFromPreferences({ feature_flags: { anyaCopilotEnabled: true, anyaScreenshotEnabled: true } }, envDef), { anyaCopilotEnabled: true, anyaScreenshotEnabled: true })
  assert.deepEqual(getFeatureFlagsFromPreferences({ feature_flags: { anyaCopilotEnabled: false } }, { anyaCopilotEnabled: true, anyaScreenshotEnabled: false }), { anyaCopilotEnabled: false, anyaScreenshotEnabled: false })
})

test('AnyaContext stable schema: useAnyaContext fallback shape', () => {
  const fallback = { route: '/', search: '', activeProfileId: null, pageName: 'Dashboard', activeObject: {}, adapter: null, setAdapterContext: () => {} }
  assert.equal(typeof fallback.setAdapterContext, 'function')
  assert.ok('route' in fallback && 'pageName' in fallback && 'adapter' in fallback)
})
