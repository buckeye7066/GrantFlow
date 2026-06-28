let sentry = null
let initPromise = null

function cleanExtra(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 20).map(cleanExtra)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/password|token|secret|authorization|cookie/i.test(key))
        .slice(0, 30)
        .map(([key, item]) => [key, cleanExtra(item)]),
    )
  }
  return String(value)
}

export function initObservability() {
  const dsn = String(process.env.SENTRY_DSN || '').trim()
  if (!dsn) return null
  if (initPromise) return initPromise

  initPromise = import('@sentry/node')
    .then((mod) => {
      mod.init({
        dsn,
        environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
        release:
          process.env.SENTRY_RELEASE ||
          process.env.RAILWAY_GIT_COMMIT_SHA ||
          process.env.VERCEL_GIT_COMMIT_SHA ||
          undefined,
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      })
      sentry = mod
      console.info('[observability] Sentry backend capture enabled')
      return mod
    })
    .catch((error) => {
      console.warn('[observability] Sentry initialization skipped:', error?.message || error)
      return null
    })

  return initPromise
}

export function captureException(error, context = {}) {
  if (!sentry) return false
  try {
    sentry.withScope((scope) => {
      if (context.requestId) scope.setTag('request_id', String(context.requestId))
      if (context.statusCode) scope.setTag('http_status', String(context.statusCode))
      if (context.retryable !== undefined) scope.setTag('retryable', String(Boolean(context.retryable)))
      scope.setExtras(cleanExtra(context))
      sentry.captureException(error)
    })
    return true
  } catch (captureError) {
    console.warn('[observability] capture failed:', captureError?.message || captureError)
    return false
  }
}

export async function flushObservability(timeoutMs = 2000) {
  if (!sentry?.flush) return false
  try {
    return await sentry.flush(timeoutMs)
  } catch {
    return false
  }
}
