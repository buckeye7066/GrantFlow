// Lightweight client-side logger.
//
// Goal:
// - Avoid shipping noisy debug logs to production.
// - Keep error logs for actionable failures.
// - Allow opt-in verbose logging during local dev.
//
// Enable verbose logs by default in dev, or by setting VITE_ENABLE_CLIENT_LOGS=true.

const IS_DEV =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV === true) ||
  String(typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.MODE : '').toLowerCase() === 'development'

const VERBOSE_ENABLED =
  IS_DEV || String(typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_ENABLE_CLIENT_LOGS : '').toLowerCase() === 'true'

function safePrefix(scope) {
  const s = String(scope || '').trim()
  return s ? `[${s}]` : '[app]'
}

export function createLogger(scope) {
  const prefix = safePrefix(scope)
  return {
    debug: (...args) => {
      if (!VERBOSE_ENABLED) return
      console.debug(prefix, ...args)
    },
    info: (...args) => {
      if (!VERBOSE_ENABLED) return
      console.info(prefix, ...args)
    },
    warn: (...args) => {
      if (!VERBOSE_ENABLED) return
      console.warn(prefix, ...args)
    },
    error: (...args) => {
      // Always log errors (actionable failures only).
      console.error(prefix, ...args)
    },
  }
}

export const logger = createLogger('ui')

