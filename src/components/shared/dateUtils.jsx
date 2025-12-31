/**
 * Safely parse a date string and return a Date object or null
 * @param {string | Date | null | undefined} dateInput - The date to parse
 * @returns {Date | null} - Parsed date or null if invalid
 */
export function parseDateSafe(dateInput) {
  if (!dateInput) return null;
  
  // If already a Date object, validate it
  if (dateInput instanceof Date) {
    return isNaN(dateInput.getTime()) ? null : dateInput;
  }
  
  // If string, try to parse
  if (typeof dateInput === 'string') {
    // Check for special cases like "rolling"
    if (dateInput.toLowerCase() === 'rolling') return null;
    
    const date = new Date(dateInput);
    return isNaN(date.getTime()) ? null : date;
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