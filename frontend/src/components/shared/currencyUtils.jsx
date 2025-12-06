/**
 * Safely format a number as currency
 * @param {number} value - The value to format
 * @returns {string} - Formatted currency string
 */
export function safeCurrency(value) {
  if (!Number.isFinite(value) || isNaN(value)) {
    return '$0';
  }
  return `$${value.toLocaleString()}`;
}

/**
 * Safely format a number with decimal places
 * @param {number} value - The value to format
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {string} - Formatted number string
 */
export function safeNumber(value, decimals = 2) {
  if (!Number.isFinite(value) || isNaN(value)) {
    return '0';
  }
  return value.toFixed(decimals);
}

/**
 * Calculate percentage safely
 * @param {number} value - The value
 * @param {number} total - The total
 * @returns {number} - Percentage (0-100)
 */
export function safePercentage(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total === 0) {
    return 0;
  }
  return Math.min((value / total) * 100, 100);
}