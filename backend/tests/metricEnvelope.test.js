import { describe, expect, it } from 'vitest'
import { buildMetricEnvelope, canCloseRegression, resolveCodeVersion } from '../services/observability/metricEnvelope.js'

describe('metricEnvelope', () => {
  it('carries window, population, evaluated/unevaluated, sample size, version, provider health and freshness', () => {
    const env = buildMetricEnvelope({
      window: { kind: 'rolling_days', days: 7, start: '2026-09-06', end: '2026-09-12' },
      population: { kind: 'live_crawls', description: 'runProfileDiscoveryLive on non-Amy profiles' },
      evaluated: 1774,
      unevaluated: 0,
      providerHealth: { search: 'healthy', llm: 'unavailable' },
      freshnessAt: '2026-09-12T16:13:30.626Z',
      codeVersion: { commit_sha: 'abc', short_sha: 'abc', runtime: 'test' },
    })
    expect(env.measurement_window).toEqual({ kind: 'rolling_days', start: '2026-09-06', end: '2026-09-12', days: 7, label: null })
    expect(env.evaluated_population.kind).toBe('live_crawls')
    expect(env.evaluated_count).toBe(1774)
    expect(env.unevaluated_count).toBe(0)
    expect(env.sample_size).toBe(1774)
    expect(env.code_version.commit_sha).toBe('abc')
    expect(env.provider_health.llm).toBe('unavailable')
    expect(env.freshness_at).toBe('2026-09-12T16:13:30.626Z')
  })

  it('reports unknowns as null, never omits them', () => {
    const env = buildMetricEnvelope({})
    expect(env.evaluated_count).toBeNull()
    expect(env.unevaluated_count).toBeNull()
    expect(env.sample_size).toBeNull()
    expect(env.freshness_at).toBeNull()
    expect(env.provider_health).toEqual({ status: 'unknown' })
    expect(env.measurement_window.kind).toBe('unknown')
  })

  it('resolves the code version with the same precedence as /api/health', () => {
    expect(resolveCodeVersion({ GIT_COMMIT_SHA: 'g', RAILWAY_GIT_COMMIT_SHA: 'r' }).commit_sha).toBe('r')
    expect(resolveCodeVersion({ VERCEL_GIT_COMMIT_SHA: 'v' }).commit_sha).toBe('v')
    expect(resolveCodeVersion({}).commit_sha).toBeNull()
  })

  it('refuses to let a point-in-time zero close a seven-day regression', () => {
    const regression = buildMetricEnvelope({ window: { kind: 'rolling_days', days: 7 }, population: { kind: 'live_crawls' }, evaluated: 1774 })
    const scoreboard = buildMetricEnvelope({ window: { kind: 'point_in_time' }, population: { kind: 'active_profiles' }, evaluated: 24 })
    expect(canCloseRegression(scoreboard, regression)).toEqual({ ok: false, reason: 'different_population' })
    const sameKindPoint = buildMetricEnvelope({ window: { kind: 'point_in_time' }, population: { kind: 'live_crawls' }, evaluated: 24 })
    expect(canCloseRegression(sameKindPoint, regression)).toEqual({ ok: false, reason: 'point_in_time_cannot_close_window' })
    const shorter = buildMetricEnvelope({ window: { kind: 'rolling_days', days: 1 }, population: { kind: 'live_crawls' }, evaluated: 300 })
    expect(canCloseRegression(shorter, regression)).toEqual({ ok: false, reason: 'shorter_window' })
    const thin = buildMetricEnvelope({ window: { kind: 'rolling_days', days: 7 }, population: { kind: 'live_crawls' }, evaluated: 5 })
    expect(canCloseRegression(thin, regression)).toEqual({ ok: false, reason: 'insufficient_sample' })
    const fresh = buildMetricEnvelope({ window: { kind: 'rolling_days', days: 7 }, population: { kind: 'live_crawls' }, evaluated: 900 })
    expect(canCloseRegression(fresh, regression)).toEqual({ ok: true, reason: null })
  })
})
