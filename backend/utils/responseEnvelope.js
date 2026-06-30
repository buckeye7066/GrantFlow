/**
 * Standardized JSON response envelope (single choke point).
 *
 * Two responsibilities, both enforced in one place so no route has to remember:
 *
 *  1. Error envelope (backward compatible): JSON *object* responses with an
 *     HTTP status >= 400 get `{ ok: false, request_id, ... }` merged in when
 *     missing. Success responses and non-object bodies are passed through
 *     untouched so public success shapes never change.
 *
 *  2. Double-send guard: a second res.json()/res.send() after the response is
 *     already committed throws "Cannot set headers after they are sent to the
 *     client". Inside an async handler that surfaces as an unhandled promise
 *     rejection the process must swallow to stay alive. Guarding here — the one
 *     wrapper every JSON response flows through — turns it into an observable
 *     no-op (logged, not silent) instead of a crash.
 *
 * `req.requestId` is expected to be set by upstream request-id middleware.
 */
export function responseEnvelope(req, res, next) {
  const originalJson = res.json.bind(res)
  res.json = (body) => {
    if (res.headersSent || res.writableEnded) {
      try {
        console.warn('[envelope] res.json() called after response already sent', {
          method: req.method,
          url: req.originalUrl || req.url,
          requestId: req.requestId || null,
        })
      } catch {
        /* logging must never throw here */
      }
      return res
    }

    const isObject = body && typeof body === 'object' && !Array.isArray(body)
    if (!isObject) {
      return originalJson(body)
    }

    const status = res.statusCode || 200
    if (status < 400) {
      return originalJson(body)
    }

    const requestId = req.requestId || null

    const normalized = Object.prototype.hasOwnProperty.call(body, 'ok')
      ? body
      : { ok: false, ...body }

    if (requestId && !Object.prototype.hasOwnProperty.call(normalized, 'request_id')) {
      normalized.request_id = requestId
    }

    return originalJson(normalized)
  }
  next()
}

export default responseEnvelope
