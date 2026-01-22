/**
 * Database Write Normalization and Validation
 * 
 * Centralized validation for enums, statuses, dates, and foreign keys before writes.
 * All high-risk database writes MUST use these validators to prevent constraint violations.
 */

/**
 * Validate and normalize job status
 * @param {string} status - Status value
 * @returns {string} Normalized status
 * @throws {Error} If status is invalid
 */
export function validateJobStatus(status) {
  const VALID_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled']
  const normalized = String(status || 'queued').toLowerCase().trim()
  
  if (!VALID_STATUSES.includes(normalized)) {
    throw new Error(`Invalid job status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`)
  }
  
  return normalized
}

/**
 * Validate and normalize grant status
 * @param {string} status - Status value
 * @returns {string} Normalized status
 * @throws {Error} If status is invalid
 */
export function validateGrantStatus(status) {
  const VALID_STATUSES = [
    'not_started',
    'in_progress',
    'submitted',
    'awarded',
    'rejected',
    'withdrawn',
  ]
  const normalized = String(status || 'not_started').toLowerCase().trim()
  
  if (!VALID_STATUSES.includes(normalized)) {
    throw new Error(`Invalid grant status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`)
  }
  
  return normalized
}

/**
 * Validate and normalize applicant type
 * @param {string} type - Applicant type
 * @returns {string} Normalized type
 * @throws {Error} If type is invalid
 */
export function validateApplicantType(type) {
  const VALID_TYPES = [
    'individual_need',
    'family',
    'organization',
    'nonprofit',
    'small_business',
    'student',
    'college_student',
    'high_school_student',
    'medical_assistance',
    'government',
    'other',
  ]
  const normalized = String(type || 'other').toLowerCase().trim()
  
  if (!VALID_TYPES.includes(normalized)) {
    throw new Error(`Invalid applicant type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`)
  }
  
  return normalized
}

/**
 * Validate and normalize document type
 * @param {string} type - Document type
 * @returns {string} Normalized type
 * @throws {Error} If type is invalid
 */
export function validateDocumentType(type) {
  const VALID_TYPES = [
    'resume',
    'cv',
    'transcript',
    'financial_statement',
    'tax_return',
    'recommendation_letter',
    'essay',
    'personal_statement',
    'application_form',
    'budget',
    'other',
  ]
  const normalized = String(type || 'other').toLowerCase().trim()
  
  if (!VALID_TYPES.includes(normalized)) {
    throw new Error(`Invalid document type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`)
  }
  
  return normalized
}

/**
 * Validate and normalize ISO date
 * @param {string|Date} date - Date value
 * @returns {string} ISO date string (YYYY-MM-DD)
 * @throws {Error} If date is invalid
 */
export function validateDate(date) {
  if (!date) {
    return null
  }

  let dateObj
  if (date instanceof Date) {
    dateObj = date
  } else {
    dateObj = new Date(date)
  }

  if (isNaN(dateObj.getTime())) {
    throw new Error(`Invalid date: ${date}`)
  }

  // Return ISO date string (YYYY-MM-DD)
  return dateObj.toISOString().split('T')[0]
}

/**
 * Validate and normalize ISO datetime
 * @param {string|Date} datetime - Datetime value
 * @returns {string} ISO datetime string
 * @throws {Error} If datetime is invalid
 */
export function validateDatetime(datetime) {
  if (!datetime) {
    return null
  }

  let dateObj
  if (datetime instanceof Date) {
    dateObj = datetime
  } else {
    dateObj = new Date(datetime)
  }

  if (isNaN(dateObj.getTime())) {
    throw new Error(`Invalid datetime: ${datetime}`)
  }

  return dateObj.toISOString()
}

/**
 * Validate US state code
 * @param {string} state - State code (2 letters)
 * @returns {string} Uppercase state code
 * @throws {Error} If state is invalid
 */
export function validateStateCode(state) {
  if (!state) {
    return null
  }

  const VALID_STATES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    'DC', 'PR', 'VI', 'GU', 'AS', 'MP',
  ]

  const normalized = String(state).toUpperCase().trim()

  if (!VALID_STATES.includes(normalized)) {
    throw new Error(`Invalid state code: ${state}. Must be a valid 2-letter US state code.`)
  }

  return normalized
}

/**
 * Validate US ZIP code
 * @param {string} zip - ZIP code
 * @returns {string} 5-digit ZIP code
 * @throws {Error} If ZIP is invalid
 */
export function validateZipCode(zip) {
  if (!zip) {
    return null
  }

  const normalized = String(zip).trim()

  // Accept 5-digit or 9-digit (with hyphen) ZIP codes
  if (!/^\d{5}(-\d{4})?$/.test(normalized)) {
    throw new Error(`Invalid ZIP code: ${zip}. Must be 5 digits or 9 digits with hyphen.`)
  }

  // Return 5-digit version
  return normalized.split('-')[0]
}

/**
 * Validate email address
 * @param {string} email - Email address
 * @returns {string} Lowercase email
 * @throws {Error} If email is invalid
 */
export function validateEmail(email) {
  if (!email) {
    return null
  }

  const normalized = String(email).toLowerCase().trim()

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`Invalid email address: ${email}`)
  }

  return normalized
}

/**
 * Validate URL
 * @param {string} url - URL
 * @returns {string} Normalized URL
 * @throws {Error} If URL is invalid
 */
export function validateUrl(url) {
  if (!url) {
    return null
  }

  const normalized = String(url).trim()

  try {
    new URL(normalized)
    return normalized
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
}

/**
 * Validate UUID
 * @param {string} uuid - UUID
 * @returns {string} Lowercase UUID
 * @throws {Error} If UUID is invalid
 */
export function validateUuid(uuid) {
  if (!uuid) {
    return null
  }

  const normalized = String(uuid).toLowerCase().trim()

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error(`Invalid UUID: ${uuid}`)
  }

  return normalized
}

/**
 * Validate foreign key exists in referenced table
 * @param {object} db - Database connection
 * @param {string} table - Referenced table name
 * @param {string} column - Referenced column name
 * @param {string} value - Foreign key value
 * @returns {Promise<boolean>} True if foreign key exists
 * @throws {Error} If foreign key doesn't exist
 */
export async function validateForeignKey(db, table, column, value) {
  if (!value) {
    return true // NULL is allowed
  }

  const row = await db
    .prepare(`SELECT ${column} FROM ${table} WHERE ${column} = ? LIMIT 1`)
    .get(value)

  if (!row) {
    throw new Error(`Foreign key constraint violation: ${value} not found in ${table}.${column}`)
  }

  return true
}

/**
 * Validate positive integer
 * @param {number|string} value - Value to validate
 * @returns {number} Positive integer
 * @throws {Error} If value is not a positive integer
 */
export function validatePositiveInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const num = Number(value)

  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`Invalid positive integer: ${value}`)
  }

  return num
}

/**
 * Validate positive number (decimal allowed)
 * @param {number|string} value - Value to validate
 * @returns {number} Positive number
 * @throws {Error} If value is not a positive number
 */
export function validatePositiveNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const num = Number(value)

  if (isNaN(num) || num < 0) {
    throw new Error(`Invalid positive number: ${value}`)
  }

  return num
}

/**
 * Validate JSON string
 * @param {string|object} value - JSON value
 * @returns {string} Valid JSON string
 * @throws {Error} If JSON is invalid
 */
export function validateJson(value) {
  if (!value) {
    return null
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  try {
    JSON.parse(value)
    return value
  } catch {
    throw new Error(`Invalid JSON: ${value}`)
  }
}

/**
 * Validate boolean value
 * @param {any} value - Value to validate
 * @returns {boolean} Boolean value
 */
export function validateBoolean(value) {
  if (value === null || value === undefined || value === '') {
    return false
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return value !== 0
  }

  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim()
    return lower === 'true' || lower === '1' || lower === 'yes'
  }

  return Boolean(value)
}
