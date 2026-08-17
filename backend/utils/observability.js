import {
  sanitizeTelemetryEvent,
  sanitizeTelemetryValue,
} from '../../shared/privacyRedaction.js'

let sentry = null
let initPromise = null

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
        // A last-hop privacy choke point. Context passed through captureException
        // is already scrubbed below, but SDK integrations can add request data,
        // breadcrumbs, and exception values independently. Sanitize the complete
        // event immediately before transport so credentials and applicant PII do
        // not leave GrantFlow through an integration we forgot to wrap.
        beforeSend(event) {
          return sanitizeTelemetryEvent(event)
        },
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
      scope.setExtras(sanitizeTelemetryValue(context))
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
