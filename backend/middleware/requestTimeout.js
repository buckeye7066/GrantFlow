/**
 * Per-route request timeout middleware.
 *
 * Sends 504 Gateway Timeout if the handler doesn't respond within `ms`.
 * Prevents slow matching/crawl queries from holding connections indefinitely.
 */

export function requestTimeout(ms) {
  return function timeout(req, res, next) {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        console.error(`[timeout] ${req.method} ${req.originalUrl} exceeded ${ms}ms`)
        res.status(504).json({
          error: 'Request timed out',
          error_type: 'gateway_timeout',
          timeout_ms: ms,
        })
      }
    }, ms)

    res.on('close', () => clearTimeout(timer))
    res.on('finish', () => clearTimeout(timer))
    next()
  }
}
