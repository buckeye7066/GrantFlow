/**
 * String Utility Functions
 * Centralized string manipulation helpers for consistent behavior across the codebase.
 */

/**
 * Normalizes a string value for comparison purposes.
 * Returns lowercase, trimmed string or empty string for non-string values.
 * 
 * @param {*} v - Value to normalize
 * @returns {string} - Normalized string
 */
export const normalize = (v) =>
  typeof v === "string" ? v.toLowerCase().trim() : "";