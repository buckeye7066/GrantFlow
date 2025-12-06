/**
 * Error Utility Functions
 * Standardized error message extraction for consistent user feedback.
 */

/**
 * Extracts a user-friendly error message from various error formats.
 * 
 * @param {*} error - Error object or value
 * @returns {string} - Human-readable error message
 */
export const getErrorMessage = (error) => {
  if (error instanceof Error) return error.message;
  if (error?.response?.data?.message) return error.response.data.message;
  if (error?.message) return error.message;
  if (error?.error) return error.error;
  return "An unexpected error occurred";
};