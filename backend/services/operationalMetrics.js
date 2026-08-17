const WINDOW_MS = 15 * 60 * 1000
const RETENTION_MS = 60 * 60 * 1000
const MAX_EVENTS = 20_000
const AVAILABILITY_TARGET = 0.995
const LATENCY_P95_TARGET_MS = 2_500

const events = []
let prunes = 0

function requestPath(req) {
  return String(req?.path || req?.originalUrl || '').split('?')[0]
}

export function classifyOperationalRoute(pathname) {
  const path = String(pathname || '').split('?')[0]
  if (path === '/healthz' || path === '/readyz' || path.startsWith('/api/health')) return 'health'
  if (path.startsWith('/api/auth')) return 'auth'
  if (path.startsWith('/api/opportunities') || path.startsWith('/api/grants')) return 'opportunities'
  if (
    path.startsWith('/api/discover')
    || path.startsWith('/api/searchOpportunities')
    || path.startsWith('/api/archOpportunities')
    || path.startsWith('/api/crawlers')
  ) return 'discovery'
  if (path.startsWith('/api/matching') || path.startsWith('/api/ai/match')) return 'matching'
  if (path.startsWith('/api/profiles') || path.startsWith('/api/organizations')) return 'profiles'
  if (path.startsWith('/api/documents') || path.startsWith('/api/parseNOFO')) return 'documents'
  if (path.startsWith('/api/proposals') || path.startsWith('/api/application-drafts')) return 'proposals'
  if (
    path.startsWith('/api/applications')
    || path.startsWith('/api/application-tasks')
    || path.startsWith('/api/hamilton')
  ) return 'applications'
  if (path.startsWith('/api/foundations') || path.startsWith('/api/funders')) return 'funders'
  if (path.startsWith('/api/admin')) return 'admin'
  return path.startsWith('/api/') ? 'other_api' : 'non_api'
}

function prune(now) {
  prunes += 1
  if (prunes % 100 !== 0 && events.length < MAX_EVENTS) return
  const cutoff = now - RETENTION_MS
  let firstRetained = 0
  while (firstRetained < events.length && events[firstRetained].at < cutoff) firstRetained += 1
  if (firstRetained > 0) events.splice(0, firstRetained)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

export function recordOperationalMetric({
  group,
  method,
  statusCode,
  durationMs,
  at = Date.now(),
} = {}) {
  const normalizedGroup = /^[a-z][a-z0-9_]{0,40}$/.test(String(group || ''))
    ? String(group)
    : 'other_api'
  const normalizedMethod = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(String(method || '').toUpperCase())
    ? String(method).toUpperCase()
    : 'OTHER'
  const status = Number(statusCode)
  const duration = Number(durationMs)
  events.push({
    group: normalizedGroup,
    method: normalizedMethod,
    statusCode: Number.isFinite(status) ? Math.max(0, Math.trunc(status)) : 0,
    durationMs: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0,
    at: Number.isFinite(Number(at)) ? Number(at) : Date.now(),
  })
  prune(Number(at) || Date.now())
}

function percentile(values, quantile) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index]
}

function summarize(groupEvents) {
  const total = groupEvents.length
  const serverErrors = groupEvents.filter((event) => event.statusCode >= 500).length
  const clientErrors = groupEvents.filter((event) => event.statusCode >= 400 && event.statusCode < 500).length
  const availability = total > 0 ? (total - serverErrors) / total : null
  const p95Ms = percentile(groupEvents.map((event) => event.durationMs), 0.95)
  const status = total === 0
    ? 'no_data'
    : availability >= AVAILABILITY_TARGET && p95Ms <= LATENCY_P95_TARGET_MS
      ? 'meeting'
      : 'breached'

  return {
    status,
    requests: total,
    server_errors: serverErrors,
    client_errors: clientErrors,
    availability,
    latency_p95_ms: p95Ms,
  }
}

export function getOperationalMetricsSnapshot({ now = Date.now(), windowMs = WINDOW_MS } = {}) {
  const cutoff = Number(now) - Math.max(1_000, Number(windowMs) || WINDOW_MS)
  const current = events.filter((event) => event.at >= cutoff && event.at <= Number(now))
  const eligible = current.filter((event) => event.group !== 'health' && event.group !== 'non_api')
  const groupNames = [...new Set(eligible.map((event) => event.group))].sort()
  const groups = Object.fromEntries(
    groupNames.map((group) => [group, summarize(eligible.filter((event) => event.group === group))]),
  )

  return {
    generated_at: new Date(Number(now)).toISOString(),
    window_ms: Math.max(1_000, Number(windowMs) || WINDOW_MS),
    objectives: {
      availability: AVAILABILITY_TARGET,
      latency_p95_ms: LATENCY_P95_TARGET_MS,
    },
    overall: summarize(eligible),
    groups,
    excluded_health_requests: current.length - eligible.length,
  }
}

function metricNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

export function renderPrometheusMetrics(snapshot = getOperationalMetricsSnapshot()) {
  const lines = [
    '# HELP grantflow_slo_requests_total Requests observed in the current SLO window.',
    '# TYPE grantflow_slo_requests_total gauge',
    `grantflow_slo_requests_total ${metricNumber(snapshot?.overall?.requests)}`,
    '# HELP grantflow_slo_server_errors_total Server errors observed in the current SLO window.',
    '# TYPE grantflow_slo_server_errors_total gauge',
    `grantflow_slo_server_errors_total ${metricNumber(snapshot?.overall?.server_errors)}`,
    '# HELP grantflow_slo_availability_ratio Availability ratio in the current SLO window.',
    '# TYPE grantflow_slo_availability_ratio gauge',
    `grantflow_slo_availability_ratio ${metricNumber(snapshot?.overall?.availability, 1)}`,
    '# HELP grantflow_slo_latency_p95_milliseconds P95 request latency in the current SLO window.',
    '# TYPE grantflow_slo_latency_p95_milliseconds gauge',
    `grantflow_slo_latency_p95_milliseconds ${metricNumber(snapshot?.overall?.latency_p95_ms)}`,
  ]

  for (const [group, metrics] of Object.entries(snapshot?.groups || {})) {
    const label = String(group).replace(/[^a-z0-9_]/gi, '_')
    lines.push(`grantflow_slo_group_requests_total{group="${label}"} ${metricNumber(metrics.requests)}`)
    lines.push(`grantflow_slo_group_server_errors_total{group="${label}"} ${metricNumber(metrics.server_errors)}`)
    lines.push(`grantflow_slo_group_availability_ratio{group="${label}"} ${metricNumber(metrics.availability, 1)}`)
    lines.push(`grantflow_slo_group_latency_p95_milliseconds{group="${label}"} ${metricNumber(metrics.latency_p95_ms)}`)
  }

  return `${lines.join('\n')}\n`
}

export function operationalMetricsMiddleware({ clock = () => Date.now() } = {}) {
  return function collectOperationalMetrics(req, res, next) {
    if (String(req?.method || '').toUpperCase() === 'OPTIONS') return next()
    const startedAt = clock()
    let recorded = false
    const record = () => {
      if (recorded) return
      recorded = true
      recordOperationalMetric({
        group: classifyOperationalRoute(requestPath(req)),
        method: req?.method,
        statusCode: res?.statusCode,
        durationMs: Math.max(0, clock() - startedAt),
        at: clock(),
      })
    }
    res.once?.('finish', record)
    res.once?.('close', record)
    return next()
  }
}

export function resetOperationalMetricsForTests() {
  events.splice(0, events.length)
  prunes = 0
}

export const OPERATIONAL_SLO = Object.freeze({
  availability: AVAILABILITY_TARGET,
  latency_p95_ms: LATENCY_P95_TARGET_MS,
  window_ms: WINDOW_MS,
})

export default {
  classifyOperationalRoute,
  getOperationalMetricsSnapshot,
  operationalMetricsMiddleware,
  recordOperationalMetric,
  renderPrometheusMetrics,
}
