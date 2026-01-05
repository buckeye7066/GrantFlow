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
    error: isProduction ? 'Internal server error' : error.message,
    ...(isProduction ? {} : { stack: error.stack })
  };
}

/**
 * Express error handling middleware
 */
export function errorHandler(err, req, res, next) {
  // Log error for debugging
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  
  // Determine status code
  const statusCode = err.statusCode || err.status || 500;
  
  // Send error response
  res.status(statusCode).json(formatError(err));
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
