import * as Sentry from '@sentry/react'

let initialized = false

function scrubExtra(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 20).map(scrubExtra)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/password|token|secret|authorization|cookie/i.test(key))
        .slice(0, 30)
        .map(([key, item]) => [key, scrubExtra(item)]),
    )
  }
  return String(value)
}

export function initFrontendObservability() {
  const dsn = String(import.meta.env.VITE_SENTRY_DSN || '').trim()
  if (!dsn || initialized) return initialized

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE || 'production',
    release:
      import.meta.env.VITE_SENTRY_RELEASE ||
      import.meta.env.VERCEL_GIT_COMMIT_SHA ||
      undefined,
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || 0),
  })
  initialized = true
  return true
}

export function captureFrontendException(error, context = {}) {
  if (!initialized) return false
  try {
    Sentry.withScope((scope) => {
      if (context.area) scope.setTag('area', String(context.area))
      if (context.route) scope.setTag('route', String(context.route))
      if (context.stale_chunk !== undefined) scope.setTag('stale_chunk', String(Boolean(context.stale_chunk)))
      scope.setExtras(scrubExtra(context))
      Sentry.captureException(error)
    })
    return true
  } catch (captureError) {
    console.warn('[observability] frontend capture failed:', captureError?.message || captureError)
    return false
  }
}
