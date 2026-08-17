import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyOperationalRoute,
  getOperationalMetricsSnapshot,
  recordOperationalMetric,
  renderPrometheusMetrics,
  resetOperationalMetricsForTests,
} from '../../backend/services/operationalMetrics.js'

test.beforeEach(() => resetOperationalMetricsForTests())

test('operational metrics expose bounded route groups without ids or raw paths', () => {
  const now = Date.parse('2026-08-17T18:00:00.000Z')
  assert.equal(classifyOperationalRoute('/api/opportunities/private-profile-id?token=secret'), 'opportunities')

  recordOperationalMetric({ group: 'opportunities', method: 'GET', statusCode: 200, durationMs: 120, at: now - 100 })
  recordOperationalMetric({ group: 'opportunities', method: 'GET', statusCode: 503, durationMs: 3_200, at: now - 50 })
  recordOperationalMetric({ group: 'health', method: 'GET', statusCode: 200, durationMs: 5, at: now - 10 })

  const snapshot = getOperationalMetricsSnapshot({ now })
  assert.equal(snapshot.overall.requests, 2)
  assert.equal(snapshot.overall.server_errors, 1)
  assert.equal(snapshot.overall.availability, 0.5)
  assert.equal(snapshot.overall.latency_p95_ms, 3_200)
  assert.equal(snapshot.overall.status, 'breached')
  assert.equal(snapshot.excluded_health_requests, 1)
  assert.deepEqual(Object.keys(snapshot.groups), ['opportunities'])

  const prometheus = renderPrometheusMetrics(snapshot)
  assert.match(prometheus, /grantflow_slo_group_requests_total\{group="opportunities"\} 2/)
  assert.doesNotMatch(prometheus, /private-profile-id|token=secret/)
})

test('operational metrics report no_data honestly before observations exist', () => {
  const snapshot = getOperationalMetricsSnapshot({ now: Date.now() })
  assert.equal(snapshot.overall.status, 'no_data')
  assert.equal(snapshot.overall.availability, null)
  assert.equal(snapshot.overall.latency_p95_ms, null)
})
