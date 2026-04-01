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
 * Express error handling middleware
 */
export async function errorHandler(err, req, res, next) {
  const requestId = req.requestId || req.request_id || null;
  const statusCode = err.statusCode || err.status || 500;

  // Store recent errors for admin lookup by request_id (in-memory, best-effort).
  try {
    await recordRequestError({
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
