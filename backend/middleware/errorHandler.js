/**
 * Centralized error handling middleware
 */

import { recordRequestError } from '../services/requestIdErrorStore.js'

/**
 * Format error response based on environment
 * @param {Error} error - The error object
 * @returns {object} Formatted error response
 */
export function formatError(error) {
  const isProduction = process.env.NODE_ENV === 'production';
  
  return {
    // Keep `error` as a string for backwards compatibility with existing clients.
    error: isProduction ? 'Internal server error' : error.message,
    error_type: error?.error_type || error?.code || error?.name || 'UnknownError',
    ...(isProduction ? {} : { stack: error.stack })
  };
}

/**
 * Is this a TRANSIENT database-contention error that the client should retry,
 * rather than a genuine server fault? Heavy read endpoints (e.g. profile
 * matching, which parallel-seq-scans ~100k funding_opportunities) can be killed
 * by Postgres `statement_timeout` (SQLSTATE 57014) or fail to acquire a pool
 * connection within `connectionTimeoutMillis` when a live crawl is saturating
 * the pool/IO at the same time. Those are momentary capacity conditions, not
 * bugs — surfacing them as 500 mislabels a retryable state as a crash. Callers
 * map a true result here to HTTP 503 so the UI can retry / show "busy" instead
 * of a hard error.
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isRetryableDbError(error) {
  if (!error) return false
  // SQLSTATE codes from node-postgres (error.code):
  //   57014 query_canceled (statement_timeout)   53300 too_many_connections
  //   53400 configuration_limit_exceeded         08xxx connection exceptions
  const code = String(error.code || '')
  if (code === '57014' || code === '53300' || code === '53400') return true
  if (code.startsWith('08')) return true
  // The pg Pool rejects connection-acquisition timeouts with a plain Error
  // (no SQLSTATE), identifiable only by message.
  const msg = String(error.message || '').toLowerCase()
  return (
    msg.includes('timeout exceeded when trying to connect') ||
    msg.includes('connection terminated due to connection timeout') ||
    msg.includes('canceling statement due to statement timeout') ||
    msg.includes('connection terminated unexpectedly') ||
    msg.includes('too many clients')
  )
}

/**
 * Express error handling middleware
 */
export function errorHandler(err, req, res, next) {
  const requestId = req.requestId || req.request_id || null;
  const statusCode = err.statusCode || err.status || 500;

  try {
    recordRequestError({
      requestId,
      path: req.path,
      method: req.method,
      statusCode,
      message: err?.message,
      stack: err?.stack,
    })
  } catch (recordError) {
    console.warn('Failed to record error:', recordError.message);
  }

  // Log error for debugging
  console.error('Error:', {
    requestId,
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  
  // Send error response
  const body = formatError(err);
  // request_id + ok flag are also enforced by the response envelope middleware.
  body.ok = false;
  if (requestId) body.request_id = requestId;
  res.status(statusCode).json(body);
}

/**
 * Async route handler wrapper to catch errors
 * @param {Function} fn - Async route handler function
 * @returns {Function} Wrapped handler
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Create an error with status code
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Error} Error with statusCode property
 */
export function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
