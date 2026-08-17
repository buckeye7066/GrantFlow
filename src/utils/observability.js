import * as Sentry from '@sentry/react'
import {
  sanitizeTelemetryEvent,
  sanitizeTelemetryValue,
} from '../../shared/privacyRedaction.js'

let initialized = false

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
    beforeSend(event) {
      return sanitizeTelemetryEvent(event)
    },
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
      scope.setExtras(sanitizeTelemetryValue(context))
      Sentry.captureException(error)
    })
    return true
  } catch (captureError) {
    console.warn('[observability] frontend capture failed:', captureError?.message || captureError)
    return false
  }
}
