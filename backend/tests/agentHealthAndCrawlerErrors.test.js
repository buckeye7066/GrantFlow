import { describe, expect, it } from 'vitest'

import { __testing__ as telemetry } from '../services/agentTelemetry/agentTelemetryAggregator.js'
import { AGENT_HEALTH } from '../services/agentTelemetry/agentTelemetryTypes.js'
import { isBenignCrawlerError } from '../services/diagnosticsService.js'

const { deriveHealth, agentProducedOutput } = telemetry

// ── Item 1: honest "ran, no output" health ────────────────────────────────
describe('deriveHealth — "ran, no output" honesty', () => {
  it('a clean run that produced ZERO output is RAN_NO_OUTPUT, not HEALTHY', () => {
    // Yana's reported symptom: ran without error, 0 pages, 0 leads.
    const yana = {
      installed: true,
      error_count: 0,
      last_success_at: '2026-06-22T10:00:00.000Z',
      last_failure_at: null,
      actions_in_window: 0,
      primary_metrics: { websites_checked: 0, leads_found: 0, leads_qualified: 0, leads_sent_to_john: 0 },
    }
    expect(deriveHealth(yana)).toBe(AGENT_HEALTH.RAN_NO_OUTPUT)
    expect(deriveHealth(yana)).not.toBe(AGENT_HEALTH.HEALTHY)
  })

  it('a clean run that DID produce output is HEALTHY', () => {
    const yana = {
      installed: true,
      error_count: 0,
      last_success_at: '2026-06-22T10:00:00.000Z',
      last_failure_at: null,
      actions_in_window: 0,
      primary_metrics: { websites_checked: 25, leads_found: 8 },
    }
    expect(deriveHealth(yana)).toBe(AGENT_HEALTH.HEALTHY)
  })

  it('unified activity (actions_in_window) counts as output even when metrics are zero', () => {
    const anya = {
      installed: true,
      error_count: 0,
      last_success_at: '2026-06-22T10:00:00.000Z',
      last_failure_at: null,
      actions_in_window: 4,
      primary_metrics: {},
    }
    expect(deriveHealth(anya)).toBe(AGENT_HEALTH.HEALTHY)
  })

  it('never ran → IDLE (not RAN_NO_OUTPUT)', () => {
    expect(deriveHealth({ installed: true, error_count: 0, last_success_at: null, last_failure_at: null, actions_in_window: 0, primary_metrics: {} }))
      .toBe(AGENT_HEALTH.IDLE)
  })

  it('errors still win over the no-output distinction (WARNING / ERROR preserved)', () => {
    expect(deriveHealth({ installed: true, error_count: 2, last_success_at: '2026-06-22T10:00:00.000Z', last_failure_at: null, actions_in_window: 0, primary_metrics: {} }))
      .toBe(AGENT_HEALTH.WARNING)
    expect(deriveHealth({ installed: true, error_count: 2, last_failure_at: '2026-06-22T11:00:00.000Z', last_success_at: '2026-06-22T10:00:00.000Z', actions_in_window: 0, primary_metrics: {} }))
      .toBe(AGENT_HEALTH.ERROR)
  })

  it('not installed → NOT_INSTALLED', () => {
    expect(deriveHealth({ installed: false })).toBe(AGENT_HEALTH.NOT_INSTALLED)
  })

  it('agentProducedOutput ignores non-numeric / negative / zero metrics', () => {
    expect(agentProducedOutput({ primary_metrics: { a: 0, b: 'x', c: null } })).toBe(false)
    expect(agentProducedOutput({ primary_metrics: { a: 0, b: 1 } })).toBe(true)
    expect(agentProducedOutput({ produced_output: false, primary_metrics: { a: 5 } })).toBe(false)
    expect(agentProducedOutput({ produced_output: true, primary_metrics: {} })).toBe(true)
  })
})

// ── Item 2: benign crawler-error classification ───────────────────────────
describe('isBenignCrawlerError — expected skips are NOT real errors', () => {
  it('treats missing_item_request (and variants) as benign', () => {
    expect(isBenignCrawlerError('missing_item_request')).toBe(true)
    expect(isBenignCrawlerError('No item request specified')).toBe(true)
    expect(isBenignCrawlerError('item_matching: no item specified')).toBe(true)
  })

  it('treats profile-deleted / no-input skips as benign', () => {
    expect(isBenignCrawlerError('profile_deleted')).toBe(true)
    expect(isBenignCrawlerError('skipped: profile_unhydrated')).toBe(true)
    expect(isBenignCrawlerError('no input provided')).toBe(true)
  })

  it('does NOT treat genuine failures as benign', () => {
    expect(isBenignCrawlerError('ECONNREFUSED contacting grants.gov')).toBe(false)
    expect(isBenignCrawlerError('TypeError: undefined is not a function')).toBe(false)
    expect(isBenignCrawlerError('HTTP 500 from SAM.gov')).toBe(false)
    expect(isBenignCrawlerError('timeout after 20000ms')).toBe(false)
  })

  it('null / empty is not benign (nothing to classify)', () => {
    expect(isBenignCrawlerError(null)).toBe(false)
    expect(isBenignCrawlerError('')).toBe(false)
  })
})
