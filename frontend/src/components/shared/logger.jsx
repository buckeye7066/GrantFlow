
/**
 * Environment-aware Logger
 * Suppresses debug/info logs in production for cleaner console output.
 * Uses console.log as fallback for environments where console.info/debug may not exist.
 */

const isDev = typeof window !== 'undefined' && 
  (window.location.hostname === 'localhost' || 
   window.location.hostname === '127.0.0.1' ||
   window.location.hostname.includes('preview'));

// Safe console methods with fallbacks
const safeInfo = typeof console.info === 'function' ? console.info.bind(console) : console.log.bind(console);
const safeDebug = typeof console.debug === 'function' ? console.debug.bind(console) : console.log.bind(console);
const safeWarn = typeof console.warn === 'function' ? console.warn.bind(console) : console.log.bind(console);
const safeError = typeof console.error === 'function' ? console.error.bind(console) : console.log.bind(console);

export const log = {
  info: (...args) => isDev && safeInfo(...args),
  warn: (...args) => safeWarn(...args),
  error: (...args) => safeError(...args),
  debug: (...args) => isDev && safeDebug(...args),
};

export default log;
