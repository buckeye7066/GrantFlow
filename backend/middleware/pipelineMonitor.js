import { sanitizeLogValue } from '../utils/logger.js'

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
  anya: { total: 0, zeroResult: 0, slow: 0, errors: 0, recent: [] },
}

// `discoveryRouter` (backend/routes/discovery.js) is mounted at `/api`, not
// at `/api/discovery`. The actual paths it serves are `/api/discover-grants`,
// `/api/comprehensiveMatch`, `/api/searchOpportunities`,
// `/api/archOpportunities`, `/api/discoverECFServices`. The previous
// `/api/discovery` prefix never matched any real request, so the
// `discovery` bucket was always empty and zero-result discovery events
// were silently lost (Goal #8 -- "avoid zero-result experiences" -- needed
// this telemetry to detect production regressions).
function classifyPath(path) {
  if (path.startsWith('/api/matching')) return 'matching'
  if (
    path.startsWith('/api/discover-grants') ||
    path.startsWith('/api/comprehensiveMatch') ||
    path.startsWith('/api/searchOpportunities') ||
    path.startsWith('/api/archOpportunities') ||
    path.startsWith('/api/discoverECFServices')
  ) {
    return 'discovery'
  }
  if (path.startsWith('/api/ai/match') || path.startsWith('/api/ai/comprehensive')) return 'ai'
  if (path.startsWith('/api/anya')) return 'anya'
  return null
}

function recordEvent(bucket, event) {
  bucket.total++
  if (event.zeroResult) bucket.zeroResult++
  if (event.slow) bucket.slow++
  if (event.error) bucket.errors++
  bucket.recent.push(event)
  if (bucket.recent.length > WINDOW_SIZE) bucket.recent.shift()
  if (event.zeroResult) bucket.lastZeroResultAt = event.ts
  if (event.error) bucket.lastErrorAt = event.ts
}

function isZeroResult(body) {
  if (!body || typeof body !== 'object') return false
  // Explicit numeric-zero counters
  if (body.returned === 0) return true
  if (body.included === 0) return true
  if (body.count === 0) return true
  // Only treat body.total as a zero-result signal when no array payload
  // contradicts it — prevents false positives from paginated/crawl responses.
  if (body.total === 0) {
    const arrayFields2 = ['opportunities', 'results', 'grants', 'matches', 'items']
    const hasItems = arrayFields2.some(f => Array.isArray(body[f]) && body[f].length > 0)
    if (!hasItems) return true
  }
  // Array payload shapes used across GrantFlow endpoints
  // Only treat an empty array as zero-result when no numeric counter
  // contradicts it (i.e. no non-zero returned/included/count present).
  const numericCounters = [body.returned, body.included, body.count]
  const hasNonZeroCounter = numericCounters.some(v => typeof v === 'number' && v > 0)
  if (!hasNonZeroCounter) {
    const arrayFields = ['opportunities', 'results', 'grants', 'matches', 'items']
    for (const field of arrayFields) {
      if (Array.isArray(body[field]) && body[field].length === 0) return true
    }
  }
  return false
}

export function pipelineMonitor() {
  return function monitor(req, res, next) {
    const group = classifyPath(req.path)
    if (!group) return next()

    const start = Date.now()
    const originalJson = res.json
    res.json = function monitoredJson(body) {
      res.json = originalJson // restore original
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
        const totalFound = body?.total_found ?? body?.total ?? body?.candidates_evaluated ?? 'unknown'
        const included = body?.included ?? body?.returned ?? body?.count ?? 0
        const suppressionNote =
          (typeof totalFound === 'number' && totalFound > 0 && included === 0)
            ? ' !! SUPPRESSION DETECTED: candidates found but none included - check relevanceFilter/matchEngine gates'
            : ''
        console.warn(
          // CodeQL js/log-injection (#558): req.path is URL-decoded by
          // Express (unlike req.url/originalUrl), so a %0A in the request
          // path would otherwise land as a raw newline in this log line.
          `[pipeline-monitor] ZERO RESULTS ${req.method} ${sanitizeLogValue(req.path)} (${elapsed}ms) ` +
          `total_found=${totalFound} included=${included} status=${res.statusCode}${suppressionNote}`
        )
      }
      if (slow) {
        console.warn(`[pipeline-monitor] SLOW ${req.method} ${sanitizeLogValue(req.path)} (${elapsed}ms)`)
      }

      return originalJson.call(this, body)
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
    if (parseFloat(zeroRate) > 50 || parseFloat(errorRate) > 50) status = 'critical'
    else if (parseFloat(zeroRate) > 20 || parseFloat(errorRate) > 10) status = 'degraded'

    health[name] = {
      status,
      total_requests: b.total,
      zero_result_count: b.zeroResult,
      zero_result_rate: `${zeroRate}%`,
      slow_count: b.slow,
      slow_rate: `${slowRate}%`,
      error_count: b.errors,
      error_rate: `${errorRate}%`,
      last_zero_result_at: b.lastZeroResultAt ?? null,
      last_error_at: b.lastErrorAt ?? null,
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
    b.lastZeroResultAt = undefined
    b.lastErrorAt = undefined
  }
}
