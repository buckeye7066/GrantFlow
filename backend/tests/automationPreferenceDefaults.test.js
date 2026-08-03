/**
 * Automation-preference DEFAULTS (2026-08-03): the two Hamilton toggles
 * (auto-apply, auto-submit) default OFF — unattended form-filling and
 * unattended SUBMISSION are consent-shaped actions, so an absent preference
 * must read as "never asked", not "yes". Before this, `hamilton_auto_submit`
 * defaulted TRUE when unset, so a profile that had never seen the Automations
 * card was auto-submit-enabled the moment any other gate opened.
 *
 * Discovery/pipeline toggles keep their behaviour-preserving TRUE defaults —
 * they are the product's core loop, not an outward-facing action.
 */

import { describe, it, expect } from 'vitest'
import {
  AUTOMATION_TOGGLES,
  defaultAutomationToggles,
  normalizeAutomationToggles,
  isAutomationEnabled,
} from '../../shared/automationPreferences.js'

describe('automation preference defaults', () => {
  it('hamilton_autopilot and hamilton_auto_submit default OFF', () => {
    const d = defaultAutomationToggles()
    expect(d.hamilton_autopilot).toBe(false)
    expect(d.hamilton_auto_submit).toBe(false)
  })

  it('discovery/pipeline toggles keep their behaviour-preserving TRUE default', () => {
    const d = defaultAutomationToggles()
    expect(d.pipeline_processing).toBe(true)
    expect(d.discovery_auto_add).toBe(true)
  })

  it('an ABSENT preference blob reads auto-submit as disabled at the enforcement point', () => {
    expect(isAutomationEnabled(null, 'hamilton_auto_submit')).toBe(false)
    expect(isAutomationEnabled({}, 'hamilton_auto_submit')).toBe(false)
    expect(isAutomationEnabled({ automations: {} }, 'hamilton_auto_submit')).toBe(false)
    expect(isAutomationEnabled(null, 'hamilton_autopilot')).toBe(false)
  })

  it('an EXPLICIT true still enables — the owner-set profiles are unaffected by the flip', () => {
    const prefs = { automations: { hamilton_auto_submit: true, hamilton_autopilot: true } }
    expect(isAutomationEnabled(prefs, 'hamilton_auto_submit')).toBe(true)
    expect(isAutomationEnabled(prefs, 'hamilton_autopilot')).toBe(true)
  })

  it('normalizeAutomationToggles fills missing Hamilton keys as FALSE, not true', () => {
    const n = normalizeAutomationToggles({ pipeline_processing: true })
    expect(n.hamilton_auto_submit).toBe(false)
    expect(n.hamilton_autopilot).toBe(false)
    expect(n.pipeline_processing).toBe(true)
  })

  it('every registered toggle declares an explicit boolean default (registry totality)', () => {
    for (const t of AUTOMATION_TOGGLES) {
      expect(typeof t.default, `toggle ${t.key} default`).toBe('boolean')
    }
  })
})
