/**
 * Common extraction utilities
 */

// US State abbreviations
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
]

// Date patterns
export const DATE_PATTERNS = {
  // MM/DD/YYYY or MM-DD-YYYY
  slashOrDash: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g,
  // YYYY-MM-DD
  iso: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
  // Month DD, YYYY
  monthDayYear: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi,
  // MON DD YYYY or MON DD, YYYY
  abbreviatedMonth: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi,
}

// Phone patterns
export const PHONE_PATTERNS = {
  standard: /\b(\d{3})[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g,
  withParens: /\((\d{3})\)\s*(\d{3})[-.\s]?(\d{4})\b/g,
}

// Email pattern
export const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g

// Zip code pattern
export const ZIP_PATTERN = /\b\d{5}(?:-\d{4})?\b/g

/**
 * Parse date string to ISO format (YYYY-MM-DD)
 * Returns null if parsing fails
 */
export function parseDate(dateStr) {
  if (!dateStr) return null

  // Try ISO format first
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) {
    const [, year, month, day] = isoMatch
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
    if (!isNaN(date.getTime())) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    }
  }

  // Try MM/DD/YYYY or MM-DD-YYYY
  const slashMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (slashMatch) {
    const [, month, day, year] = slashMatch
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
    if (!isNaN(date.getTime())) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    }
  }

  // Try parsing with Date constructor as fallback
  const date = new Date(dateStr)
  if (!isNaN(date.getTime())) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  return null
}

/**
 * Extract all dates from text
 */
export function extractDates(text) {
  const dates = []
  
  // Try all date patterns
  for (const [patternName, pattern] of Object.entries(DATE_PATTERNS)) {
    const matches = [...text.matchAll(pattern)]
    for (const match of matches) {
      const dateStr = match[0]
      const parsed = parseDate(dateStr)
      if (parsed) {
        dates.push({
          raw: dateStr,
          iso: parsed,
          pattern: patternName,
          confidence: 0.85,
        })
      }
    }
  }
  
  return dates
}

/**
 * Extract phone numbers from text
 */
export function extractPhones(text) {
  const phones = []
  
  for (const [patternName, pattern] of Object.entries(PHONE_PATTERNS)) {
    const matches = [...text.matchAll(pattern)]
    for (const match of matches) {
      const digits = match[0].replace(/\D/g, '')
      if (digits.length === 10) {
        phones.push({
          raw: match[0],
          formatted: `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`,
          pattern: patternName,
          confidence: 0.9,
        })
      }
    }
  }
  
  return phones
}

/**
 * Extract emails from text
 */
export function extractEmails(text) {
  const emails = []
  const matches = [...text.matchAll(EMAIL_PATTERN)]
  
  for (const match of matches) {
    emails.push({
      raw: match[0],
      normalized: match[0].toLowerCase(),
      confidence: 0.95,
    })
  }
  
  return emails
}

/**
 * Extract zip codes from text
 */
export function extractZipCodes(text) {
  const zips = []
  const matches = [...text.matchAll(ZIP_PATTERN)]
  
  for (const match of matches) {
    zips.push({
      raw: match[0],
      confidence: 0.85,
    })
  }
  
  return zips
}

/**
 * Extract US states from text
 */
export function extractStates(text) {
  const states = []
  const statePattern = new RegExp(`\\b(${US_STATES.join('|')})\\b`, 'g')
  const matches = [...text.matchAll(statePattern)]
  
  for (const match of matches) {
    states.push({
      raw: match[0],
      confidence: 0.8,
    })
  }
  
  return states
}

/**
 * Extract addresses from text (basic implementation)
 * Looks for patterns like "123 Main St, City, ST 12345"
 */
export function extractAddresses(text) {
  const addresses = []
  
  // Pattern: number + street + optional unit + city + state + zip
  const addressPattern = /\b(\d+)\s+([A-Za-z0-9\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Boulevard|Blvd|Way|Place|Pl)\.?)\s*(?:,\s*([A-Za-z\s]+))?\s*,?\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/gi
  
  const matches = [...text.matchAll(addressPattern)]
  
  for (const match of matches) {
    const [full, number, street, city, state, zip] = match
    addresses.push({
      raw: full,
      number,
      street,
      city: city || '',
      state,
      zip,
      confidence: 0.75,
    })
  }
  
  return addresses
}

/**
 * Calculate confidence score based on keyword matches
 */
export function calculateConfidence(text, keywords, weights = {}) {
  const normalizedText = text.toLowerCase()
  let score = 0
  let maxScore = 0
  
  for (const [keyword, weight] of Object.entries(keywords)) {
    const keywordWeight = weights[keyword] || weight
    maxScore += keywordWeight
    
    if (normalizedText.includes(keyword.toLowerCase())) {
      score += keywordWeight
    }
  }
  
  return maxScore > 0 ? Math.min(score / maxScore, 1.0) : 0
}

/**
 * Clean and normalize text
 */
export function normalizeText(text) {
  return text
    .replace(/\s+/g, ' ')  // Normalize whitespace
    .replace(/[^\x20-\x7E]/g, '') // Remove non-printable chars
    .trim()
}

/**
 * Extract name patterns from text
 * Looks for capitalized words that might be names
 */
export function extractNamePatterns(text) {
  const names = []
  
  // Pattern: Capitalized word followed by optional middle initial and capitalized last name
  const namePattern = /\b([A-Z][a-z]+)(?:\s+([A-Z])\.?)?\s+([A-Z][a-z]+)\b/g
  
  const matches = [...text.matchAll(namePattern)]
  
  for (const match of matches) {
    const [full, first, middle, last] = match
    names.push({
      raw: full,
      first,
      middle: middle || '',
      last,
      confidence: 0.6, // Lower confidence as this is just a pattern match
    })
  }
  
  return names
}

export default {
  US_STATES,
  DATE_PATTERNS,
  PHONE_PATTERNS,
  EMAIL_PATTERN,
  ZIP_PATTERN,
  parseDate,
  extractDates,
  extractPhones,
  extractEmails,
  extractZipCodes,
  extractStates,
  extractAddresses,
  calculateConfidence,
  normalizeText,
  extractNamePatterns,
}
