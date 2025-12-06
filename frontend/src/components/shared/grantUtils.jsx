/**
 * Utility functions for grant operations
 */

/**
 * Statuses that are eligible for expiration marking
 * Grants in later stages (drafting, submitted, etc.) should not be marked expired
 */
export const EXPIRED_ELIGIBLE_STATUSES = ['discovered', 'interested'];

/**
 * Check if a grant deadline has expired
 * FIXED: Also check if grant is in an eligible status for expiration
 * @param {Object} grant - The grant object
 * @param {Date} now - Optional reference date (defaults to current date)
 * @returns {boolean} - True if the grant is expired AND in an eligible status
 */
export function isGrantExpired(grant, now = new Date()) {
  if (!grant) return false;
  if (!grant.deadline) return false;
  
  const deadlineVal = grant.deadline;
  if (typeof deadlineVal === 'string' && deadlineVal.trim().toLowerCase() === 'rolling') return false;
  
  const deadlineDate = new Date(deadlineVal);
  if (isNaN(deadlineDate.getTime())) return false;
  
  // Set both dates to start of day for accurate comparison
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  deadlineDate.setHours(0, 0, 0, 0);
  
  const isExpired = deadlineDate < today;
  
  // Only mark as expired if in eligible status
  const isInEligibleStatus = EXPIRED_ELIGIBLE_STATUSES.includes(grant.status);
  
  return isExpired && isInEligibleStatus;
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

/**
 * Get all valid status values
 * @returns {string[]} Array of valid status values
 */
export const VALID_GRANT_STATUSES = [
  'discovered',
  'interested',
  'auto_applied',
  'drafting',
  'application_prep',
  'revision',
  'portal',
  'submitted',
  'pending_review',
  'follow_up',
  'awarded',
  'report',
  'declined',
  'closed'
];