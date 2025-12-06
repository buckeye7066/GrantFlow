/**
 * Check if a date string is valid and parseable
 * @param {any} val - Date value to check
 * @returns {boolean}
 */
export function isValidDate(val) {
  if (!val) return false;
  try {
    const d = new Date(val);
    return !Number.isNaN(d.getTime());
  } catch {
    return false;
  }
}

/**
 * Safely format a currency amount
 * @param {any} val - Amount to format
 * @returns {string}
 */
export function formatCurrency(val) {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num) || num < 0) return '$0';
  return `$${num.toLocaleString()}`;
}

/**
 * Safely format a date for display
 * @param {any} val - Date string/object
 * @param {object} options - Intl.DateTimeFormat options
 * @returns {string}
 */
export function formatDate(val, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!isValidDate(val)) return 'N/A';
  try {
    return new Intl.DateTimeFormat('en-US', options).format(new Date(val));
  } catch {
    return 'N/A';
  }
}

/**
 * Calculate days left until end date
 * @param {string} endDate - End date string
 * @returns {number} - Days remaining
 */
export function getDaysLeft(endDate) {
  if (!isValidDate(endDate)) return 0;
  
  try {
    const end = new Date(endDate);
    const now = new Date();
    const diffTime = end.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 3600 * 24));
    return Math.max(0, diffDays);
  } catch (error) {
    console.error('[stewardshipHelpers] Error calculating days left:', error);
    return 0;
  }
}

/**
 * Get the next due date from a list of reports
 * @param {Array} reports - Array of report objects
 * @returns {string|null} - Next due date or null
 */
export function getNextDueDate(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return null;
  
  const now = new Date();
  const upcomingReports = reports
    .filter(r => {
      if (r?.status === 'submitted' || r?.status === 'accepted') return false;
      if (!isValidDate(r?.due_date)) return false;
      
      try {
        const dueDate = new Date(r.due_date);
        return dueDate >= now;
      } catch {
        return false;
      }
    })
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  
  return upcomingReports.length > 0 ? upcomingReports[0].due_date : null;
}