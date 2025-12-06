import { formatDistanceToNow } from 'date-fns';

/**
 * Get relative time string from a date
 * @param {string | Date} date - The date to format
 * @returns {string} - Relative time string (e.g., "2 hours")
 */
export function getRelativeTime(date) {
  if (!date) return '';
  
  try {
    return formatDistanceToNow(new Date(date));
  } catch (error) {
    console.error('Error formatting date:', error);
    return '';
  }
}