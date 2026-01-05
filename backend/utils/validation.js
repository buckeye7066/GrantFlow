import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, MIN_PAGE_LIMIT, DEFAULT_OFFSET } from '../config/constants.js';

/**
 * Validate and sanitize pagination parameters
 * @param {object} query - Request query object
 * @returns {object} Validated limit and offset
 */
export function validatePagination(query) {
  const limit = Math.min(
    Math.max(MIN_PAGE_LIMIT, parseInt(query.limit, 10) || DEFAULT_PAGE_LIMIT),
    MAX_PAGE_LIMIT
  );
  
  const offset = Math.max(0, parseInt(query.offset, 10) || DEFAULT_OFFSET);
  
  return { limit, offset };
}

/**
 * Validate required fields in request body
 * @param {object} body - Request body
 * @param {string[]} requiredFields - Array of required field names
 * @returns {object} { valid: boolean, missingFields: string[] }
 */
export function validateRequiredFields(body, requiredFields) {
  const missingFields = [];
  
  for (const field of requiredFields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      missingFields.push(field);
    }
  }
  
  return {
    valid: missingFields.length === 0,
    missingFields
  };
}

/**
 * Sanitize SQL column names against a whitelist
 * @param {object} data - Object with column names as keys
 * @param {Set<string>} allowedColumns - Set of allowed column names
 * @returns {object} Sanitized object with only allowed columns
 */
export function sanitizeColumns(data, allowedColumns) {
  const sanitized = {};
  
  for (const [key, value] of Object.entries(data)) {
    if (allowedColumns.has(key)) {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Validate email format
 * @param {string} email - Email address to validate
 * @returns {boolean} True if valid email format
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate string length
 * @param {string} str - String to validate
 * @param {number} minLength - Minimum length (default: 1)
 * @param {number} maxLength - Maximum length (default: 10000)
 * @returns {boolean} True if valid length
 */
export function isValidStringLength(str, minLength = 1, maxLength = 10000) {
  if (typeof str !== 'string') {
    return false;
  }
  
  const trimmed = str.trim();
  return trimmed.length >= minLength && trimmed.length <= maxLength;
}
