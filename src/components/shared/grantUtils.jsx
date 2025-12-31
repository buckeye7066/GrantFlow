/**
 * Utility functions for grant operations
 */

/**
 * Check if a grant deadline has expired
 * @param {Object} grant - The grant object
 * @returns {boolean} - True if the grant is expired
 */
export function isGrantExpired(grant) {
  if (!grant.deadline) return false;
  if (grant.deadline.toLowerCase() === 'rolling') return false;
  
  const deadlineDate = new Date(grant.deadline);
  if (isNaN(deadlineDate.getTime())) return false;
  
  return deadlineDate < new Date();
}

/**
 * Check if a date string is valid
 * @param {string} dateString - The date string to validate
 * @returns {boolean} - True if valid date
 */
export function isValidDate(dateString) {
  if (!dateString) return false;
  const date = new Date(dateString);
  return !isNaN(date.getTime());
}