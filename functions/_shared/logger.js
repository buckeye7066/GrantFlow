/**
 * CENTRALIZED LOGGING UTILITY
 * 
 * Production-ready logging with environment awareness.
 * For Base44 integration, this ensures logs are only emitted in development/test environments.
 * 
 * Usage:
 *   import { logger } from './_shared/logger.js';
 *   logger.debug('message', { context });  // Only in dev
 *   logger.info('message', { context });   // Only in dev  
 *   logger.warn('message', { context });   // Always shown
 *   logger.error('message', { context });  // Always shown
 */

const isDevelopment = () => {
  // Check for Deno environment first, then Node.js
  if (typeof Deno !== 'undefined') {
    return Deno.env.get('DENO_ENV') !== 'production' && 
           Deno.env.get('NODE_ENV') !== 'production';
  }
  // Node.js/Browser environment
  if (typeof process !== 'undefined' && process.env) {
    return process.env.NODE_ENV !== 'production';
  }
  // Default to development if environment is unclear
  return true;
};

const formatMessage = (level, source, message, context) => {
  const timestamp = new Date().toISOString();
  const contextStr = context && Object.keys(context).length > 0 
    ? ` ${JSON.stringify(context)}` 
    : '';
  return `[${timestamp}] [${level.toUpperCase()}] [${source}]${contextStr} ${message}`;
};

/**
 * Create a logger instance for a specific source/module
 * @param {string} source - The name of the module/function (e.g., 'crawlGrantsGov', 'safeHandler')
 */
export function createLogger(source = 'unknown') {
  return {
    /**
     * Debug logging - only in development
     * Use for detailed debugging information, not needed in production
     */
    debug: (message, context = {}) => {
      if (isDevelopment()) {
        console.log(formatMessage('debug', source, message, context));
      }
    },

    /**
     * Info logging - only in development
     * Use for general informational messages
     */
    info: (message, context = {}) => {
      if (isDevelopment()) {
        console.log(formatMessage('info', source, message, context));
      }
    },

    /**
     * Warning logging - always shown
     * Use for recoverable issues that should be investigated
     */
    warn: (message, context = {}) => {
      console.warn(formatMessage('warn', source, message, context));
    },

    /**
     * Error logging - always shown
     * Use for errors that need immediate attention
     */
    error: (message, context = {}) => {
      console.error(formatMessage('error', source, message, context));
    },
  };
}

// Default logger for general use
export const logger = createLogger('app');
