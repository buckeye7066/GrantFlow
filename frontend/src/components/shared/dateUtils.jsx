import { format } from 'date-fns';

/**
 * L4 FIX: Unified date parsing helper - alias for parseDateSafe
 * @param {string | Date | null | undefined} dateInput - The date to parse
 * @returns {Date | null} - Parsed date or null if invalid
 */
export const parseDate = (dateInput) => parseDateSafe(dateInput);

/**
 * Safely parse a date string and return a Date object or null
 * @param {string | Date | null | undefined} dateInput - The date to parse
 * @returns {Date | null} - Parsed date or null if invalid
 */
export function parseDateSafe(dateInput) {
  if (!dateInput) return null;
  
  try {
    // If already a Date object, validate it
    if (dateInput instanceof Date) {
      return Number.isNaN(dateInput.getTime()) ? null : dateInput;
    }
    
    // If string, try to parse
    if (typeof dateInput === 'string') {
      const trimmed = dateInput.trim();
      // Check for special cases like "rolling"
      if (trimmed.toLowerCase() === 'rolling') return null;
      if (!trimmed) return null;
      
      const date = new Date(trimmed);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    
    // If number (timestamp), try to parse
    if (typeof dateInput === 'number' && Number.isFinite(dateInput)) {
      const date = new Date(dateInput);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  } catch (err) {
    console.warn('[parseDateSafe] Error parsing date:', err?.message);
  }
  
  return null;
}

/**
 * Check if a date string is valid
 * @param {string | Date | null | undefined} dateInput - The date to validate
 * @returns {boolean} - Whether the date is valid
 */
export function isValidDate(dateInput) {
  return parseDateSafe(dateInput) !== null;
}

/**
 * Safely format a date using date-fns format
 * Returns fallback text if date is invalid
 * @param {string | Date | null | undefined} dateInput - The date to format
 * @param {string} formatString - The date-fns format string (default: 'MMM d, yyyy')
 * @param {string} fallback - Text to return if date is invalid (default: 'TBD')
 * @returns {string} - Formatted date or fallback
 */
export function formatDateSafe(dateInput, formatString = 'MMM d, yyyy', fallback = 'TBD') {
  const date = parseDateSafe(dateInput);
  if (!date) return fallback;
  
  try {
    return format(date, formatString);
  } catch (error) {
    console.warn('[formatDateSafe] Format error:', error?.message, { dateInput, formatString });
    return fallback;
  }
}

/**
 * Safely format a number with toLocaleString
 * @param {number | string | null | undefined} value - The number to format
 * @param {string} fallback - Fallback text if invalid (default: 'N/A')
 * @returns {string} - Formatted number or fallback
 */
export function formatNumberSafe(value, fallback = 'N/A') {
  if (value === null || value === undefined) return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  try {
    return num.toLocaleString();
  } catch {
    return String(num);
  }
}

/**
 * Safely format currency
 * @param {number | string | null | undefined} value - The amount
 * @param {string} fallback - Fallback text (default: 'N/A')
 * @returns {string} - Formatted currency or fallback
 */
export function formatCurrencySafe(value, fallback = 'N/A') {
  if (value === null || value === undefined) return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  try {
    return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } catch {
    return `$${num.toFixed(2)}`;
  }
}

/**
 * Safely format with toFixed
 * @param {number | string | null | undefined} value - The number
 * @param {number} decimals - Decimal places (default: 2)
 * @param {string} fallback - Fallback (default: '0.00')
 * @returns {string}
 */
export function toFixedSafe(value, decimals = 2, fallback = '0.00') {
  if (value === null || value === undefined) return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  try {
    return num.toFixed(decimals);
  } catch {
    return fallback;
  }
}

/**
 * Get deadline display text
 * @param {string | Date | null | undefined} deadline - The deadline to display
 * @returns {string} - Display text for deadline
 */
export function getDeadlineText(deadline) {
  if (!deadline) return 'No deadline';
  
  if (typeof deadline === 'string' && deadline.trim().toLowerCase() === 'rolling') {
    return 'Rolling';
  }
  
  return formatDateSafe(deadline, 'MMM d, yyyy', 'Invalid date');
}