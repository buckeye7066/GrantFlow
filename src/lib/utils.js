import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

/**
 * Parse a timestamp string, treating SQLite timestamps as UTC.
 * SQLite stores timestamps like "2026-01-11 23:38:43" without timezone.
 * This function ensures they're parsed as UTC, not local time.
 * @param {string|Date|number} value - Timestamp to parse
 * @returns {Date|null} - Parsed date or null if invalid
 */
export function parseTimestamp(value) {
  if (!value) return null
  if (value instanceof Date) return value
  
  let normalized = value
  if (typeof value === 'string' && !value.endsWith('Z') && !value.includes('+') && !value.includes('-', 10)) {
    // Convert "2026-01-11 23:38:43" to "2026-01-11T23:38:43Z"
    normalized = value.replace(' ', 'T') + 'Z'
  }
  
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
} 