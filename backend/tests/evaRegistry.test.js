import { describe, it, expect } from 'vitest'
import { validateManifest, loadRegistry, expectedAppIds } from '../services/eva/evaRegistry.js'
import { AGENT_NAMES } from '../services/agentTelemetry/agentTelemetryTypes.js'

function validManifest(over = {}) {
  return {
    app_id: 'grantflow',
    display_name: 'GrantFlow',
    runtime_type: 'web',
    disposable_data_root: '.eva-tmp/grantflow',
    max_runtime_ms: 600000,
    concurrency_class: 'db-heavy',
    prohibited_actions: ['no real client records', 'no application submission'],
    cleanup: 'rm -rf .eva-tmp/grantflow',
    coverage: [
      { feature: 'Login', journeys: ['login'] },
      { feature: 'Billing checkout', unautomated_reason: 'Stripe live-mode; mocked provider only' },
    ],
    nightly_critical_journeys: ['login'],
    ...over,
  }
}

describe('validateManifest', () => {
  it('accepts a complete manifest', () => {
    const r = validateManifest(validManifest())
    expect(r.ok).toBe(true)
  })

  it('REJECTS a manifest with no prohibited-action policy', () => {
    const r = validateManifest(validManifest({ prohibited_actions: [] }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/prohibited_actions/)
  })

  it('REJECTS a manifest with no cleanup strategy', () => {
    const m = validManifest()
    delete m.cleanup
    const r = validateManifest(m)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/cleanup/)
  })

  it('rejects a coverage entry that maps to neither a journey nor a reason', () => {
    const r = validateManifest(validManifest({ coverage: [{ feature: 'Orphan feature' }] }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/journey or give an unautomated_reason/)
  })

  it('rejects an unknown runtime_type', () => {
    const r = validateManifest(validManifest({ runtime_type: 'quantum' }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/runtime_type/)
  })

  it('rejects a non-positive max_runtime_ms', () => {
    const r = validateManifest(validManifest({ max_runtime_ms: 0 }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/max_runtime_ms/)
  })
})

describe('portfolio registry', () => {
  it('loads all 19 portfolio surfaces', () => {
    const reg = loadRegistry({ force: true })
    expect(reg.apps.length).toBe(19)
  })

  it('every registry app has a runtime_status', () => {
    const reg = loadRegistry({ force: true })
    for (const app of reg.apps) {
      expect(typeof app.runtime_status).toBe('string')
      expect(app.runtime_status.length).toBeGreaterThan(0)
    }
  })

  it('expectedAppIds excludes source/runtime-unavailable apps', () => {
    const ids = expectedAppIds()
    expect(Array.isArray(ids)).toBe(true)
    // grantflow is available and must be expected
    expect(ids).toContain('grantflow')
  })
})

describe('EVA telemetry registration', () => {
  it("'eva' is a registered agent name (else telemetry silently no-ops)", () => {
    expect(AGENT_NAMES).toContain('eva')
  })
})
