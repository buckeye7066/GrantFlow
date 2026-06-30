import { formatDistanceToNow } from "date-fns";

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

/**
 * Parse a date as LOCAL midnight when it is a bare calendar date (YYYY-MM-DD).
 *
 * `new Date("2026-06-29")` parses as UTC midnight, which in a negative-offset
 * zone (US Eastern = UTC-4) is 2026-06-28 20:00 LOCAL. Comparing that against a
 * local "now" makes day math off by one, so a grant due Jun 29 gets labeled
 * "Due today" when today is Jun 30. For bare dates we build the Date from local
 * Y/M/D so all day math matches the user's wall clock. Timestamps with an
 * explicit time/zone are passed through unchanged.
 *
 * @param {string | Date | null | undefined} dateInput
 * @returns {Date | null}
 */
export function parseLocalDate(dateInput) {
  if (!dateInput) return null;
  if (dateInput instanceof Date) return isNaN(dateInput.getTime()) ? null : dateInput;
  if (typeof dateInput === 'string') {
    if (dateInput.toLowerCase() === 'rolling') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput.trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(dateInput);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Local midnight for today. */
export function startOfToday() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/**
 * Whole calendar days from local-today to a deadline. Negative = overdue,
 * 0 = due today, positive = upcoming. Returns null for invalid/rolling dates.
 * This is THE deadline comparator — use it everywhere instead of ad-hoc
 * `differenceInDays(new Date(deadline), new Date())` so "Due today" can't drift.
 */
export function daysUntilLocal(dateInput) {
  const d = parseLocalDate(dateInput);
  if (!d) return null;
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((target.getTime() - startOfToday().getTime()) / 86400000);
}

/** True when the deadline is the local calendar's today. */
export function isDueToday(dateInput) {
  return daysUntilLocal(dateInput) === 0;
}

/** True when the deadline is strictly before today (overdue). */
export function isOverdue(dateInput) {
  const n = daysUntilLocal(dateInput);
  return n !== null && n < 0;
}

/**
 * Safely format relative time. date-fns throws RangeError for Invalid Date;
 * callers should get null and skip the label instead of crashing a route.
 * @param {string | Date | null | undefined} dateInput
 * @param {object} options
 * @returns {string | null}
 */
export function formatDistanceToNowSafe(dateInput, options) {
  const date = parseDateSafe(dateInput);
  if (!date) return null;
  return formatDistanceToNow(date, options);
}