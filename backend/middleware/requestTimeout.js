import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('middleware:requestTimeout')
/**
 * Per-route request timeout middleware.
 *
 * Sends 504 Gateway Timeout if the handler doesn't respond within `ms`.
 * Prevents slow matching/crawl queries from holding connections indefinitely.
 */

export function requestTimeout(ms) {
  return function timeout(req, res, next) {
    let timer = setTimeout(() => {
      if (!res.headersSent && !res.writableEnded) {
        qualityLog.error(`[timeout] ${req.method} ${req.originalUrl} exceeded ${ms}ms`)
        try {
          res.status(504).json({
            error: 'Request timed out',
            error_type: 'gateway_timeout',
            timeout_ms: ms,
          })
        } catch (err) {
          qualityLog.error(`[timeout] Failed to send timeout response: ${err.message}`)
        }
      }
    }, ms)

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      req.removeListener('close', cleanup)
      res.removeListener('close', cleanup)
      res.removeListener('finish', cleanup)
      res.removeListener('error', cleanup)
    }
    
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('finish', cleanup)
    res.on('error', cleanup)
    next()
  }
}
