/**
 * Utility functions for grant operations
 */

/**
 * Check if a grant deadline has expired
 * @param {Object} grant - The grant object
 * @returns {boolean} - True if the grant is expired
 */
/**
 * @typedef {'expired'|'active'|'rolling'|'unknown'} DeadlineStatus
 */

/**
 * Classify a grant's deadline status.
 * Returns 'unknown' (not 'active') when deadline is absent or unparseable,
 * so callers can distinguish confirmed-open from unverified.
 * @param {Object} grant
 * @returns {DeadlineStatus}
 */
export function getDeadlineStatus(grant) {
  if (!grant.deadline) return 'unknown';
  const dl = String(grant.deadline).trim().toLowerCase();
  if (dl === 'rolling' || dl === 'ongoing' || dl === 'open') return 'rolling';
  const deadlineDate = new Date(grant.deadline);
  if (isNaN(deadlineDate.getTime())) return 'unknown';
  return deadlineDate < new Date() ? 'expired' : 'active';
}

/**
 * Check if a grant deadline has expired.
 * NOTE: Returns false for 'rolling' and 'active' deadlines only.
 * Returns false for 'unknown' deadlines — callers MUST handle 'unknown'
 * separately rather than treating it as confirmed-open.
 * @param {Object} grant
 * @returns {boolean}
 */
export function isGrantExpired(grant) {
  return getDeadlineStatus(grant) === 'expired';
}

/**
 * Check if a date string is valid
 * @param {string} dateString - The date string to validate
 * @returns {boolean} - True if valid date
 */
/**
 * Check if a date string is parseable and optionally not in the past.
 * @param {string} dateString
 * @param {{ allowPast?: boolean }} [options]
 * @returns {{ valid: boolean, isPast: boolean, parsed: Date|null }}
 */
export function isValidDate(dateString, { allowPast = true } = {}) {
  if (!dateString) return { valid: false, isPast: false, parsed: null };
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return { valid: false, isPast: false, parsed: null };
  const isPast = date < new Date();
  const valid = allowPast ? true : !isPast;
  return { valid, isPast, parsed: date };
}