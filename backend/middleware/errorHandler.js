/**
 * Centralized error handling middleware
 */

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
    error_type: error?.error_type || error?.code || null,
    ...(isProduction ? {} : { stack: error.stack })
  };
}

/**
 * Express error handling middleware
 */
export function errorHandler(err, req, res, next) {
  const requestId = req.requestId || req.request_id || null;

  // Log error for debugging
  console.error('Error:', {
    requestId,
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  
  // Determine status code
  const statusCode = err.statusCode || err.status || 500;
  
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
