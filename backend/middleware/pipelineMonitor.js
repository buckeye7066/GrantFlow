/**
 * Lightweight production monitoring for matching/discovery endpoints.
 *
 * Tracks:
 *   - Zero-result responses (a failure state per project rules)
 *   - Slow responses (> threshold)
 *   - Error rates per endpoint group
 *
 * Exposes /api/admin/pipeline-health for dashboards.
 * All data is in-memory with a rolling window — no external deps.
 */

const SLOW_THRESHOLD_MS = parseInt(process.env.PIPELINE_SLOW_MS || '5000', 10)
const WINDOW_SIZE = 200

const buckets = {
  matching: { total: 0, zeroResult: 0, slow: 0, errors: 0, recent: [] },
  discovery: { total: 0, zeroResult: 0, slow: 0, errors: 0, recent: [] },
  ai: { total: 0, zeroResult: 0, slow: 0, errors: 0, recent: [] },
}

function classifyPath(path) {
  if (path.startsWith('/api/matching')) return 'matching'
  if (path.startsWith('/api/discovery')) return 'discovery'
  if (path.startsWith('/api/ai/match') || path.startsWith('/api/ai/comprehensive')) return 'ai'
  return null
}

function recordEvent(bucket, event) {
  bucket.total++
  if (event.zeroResult) bucket.zeroResult++
  if (event.slow) bucket.slow++
  if (event.error) bucket.errors++
  bucket.recent.push(event)
  if (bucket.recent.length > WINDOW_SIZE) bucket.recent.shift()
}

function isZeroResult(body) {
  if (!body || typeof body !== 'object') return false
  if (body.returned === 0) return true
  if (body.total === 0 && body.opportunities?.length === 0) return true
  if (Array.isArray(body.opportunities) && body.opportunities.length === 0) return true
  return false
}

export function pipelineMonitor() {
  return function monitor(req, res, next) {
    const group = classifyPath(req.path)
    if (!group) return next()

    const start = Date.now()
    const originalJson = res.json.bind(res)

    res.json = function monitoredJson(body) {
      const elapsed = Date.now() - start
      const slow = elapsed > SLOW_THRESHOLD_MS
      const zeroResult = isZeroResult(body)
      const error = res.statusCode >= 500

      recordEvent(buckets[group], {
        path: req.path,
        method: req.method,
        status: res.statusCode,
        elapsed,
        slow,
        zeroResult,
        error,
        ts: new Date().toISOString(),
      })

      if (zeroResult) {
        console.warn(`[pipeline-monitor] ZERO RESULTS ${req.method} ${req.path} (${elapsed}ms)`)
      }
      if (slow) {
        console.warn(`[pipeline-monitor] SLOW ${req.method} ${req.path} (${elapsed}ms)`)
      }

      return originalJson(body)
    }

    next()
  }
}

export function getPipelineHealth() {
  const health = {}
  for (const [name, b] of Object.entries(buckets)) {
    const zeroRate = b.total > 0 ? (b.zeroResult / b.total * 100).toFixed(1) : '0.0'
    const slowRate = b.total > 0 ? (b.slow / b.total * 100).toFixed(1) : '0.0'
    const errorRate = b.total > 0 ? (b.errors / b.total * 100).toFixed(1) : '0.0'

    let status = 'healthy'
    if (parseFloat(zeroRate) > 50) status = 'critical'
    else if (parseFloat(zeroRate) > 20) status = 'degraded'
    else if (parseFloat(errorRate) > 10) status = 'degraded'

    health[name] = {
      status,
      total_requests: b.total,
      zero_result_count: b.zeroResult,
      zero_result_rate: `${zeroRate}%`,
      slow_count: b.slow,
      slow_rate: `${slowRate}%`,
      error_count: b.errors,
      error_rate: `${errorRate}%`,
      last_events: b.recent.slice(-5),
    }
  }

  const overall = Object.values(health).some(h => h.status === 'critical')
    ? 'critical'
    : Object.values(health).some(h => h.status === 'degraded')
      ? 'degraded'
      : 'healthy'

  return { overall, slow_threshold_ms: SLOW_THRESHOLD_MS, buckets: health }
}

export function resetPipelineMetrics() {
  for (const b of Object.values(buckets)) {
    b.total = 0
    b.zeroResult = 0
    b.slow = 0
    b.errors = 0
    b.recent = []
  }
}
