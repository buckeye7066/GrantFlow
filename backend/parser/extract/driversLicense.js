import {
  extractDates,
  extractStates,
  extractAddresses,
  extractZipCodes,
  extractNamePatterns,
  normalizeText,
} from './common.js'

/**
 * Extract data from driver's license
 * NOTE: We do NOT extract or store the actual DL number for security
 */
export function extractDriversLicense(text) {
  const normalized = normalizeText(text)
  const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean)
  
  const extracted = {
    full_name: null,
    dob: null,
    address_line1: null,
    city: null,
    state: null,
    zip: null,
    expiration_date: null,
  }
  
  // Extract dates (likely DOB and expiration)
  const dates = extractDates(text)
  if (dates.length > 0) {
    // Find DOB - look for "DOB" label nearby
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i]
      const context = text.substring(
        Math.max(0, text.indexOf(date.raw) - 50),
        text.indexOf(date.raw) + 50
      ).toLowerCase()
      
      if (context.includes('dob') || context.includes('birth')) {
        extracted.dob = {
          value: date.iso,
          confidence: 0.9,
        }
        break
      }
    }
    
    // Find expiration - look for "EXP" or "EXPIRES" label
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i]
      const context = text.substring(
        Math.max(0, text.indexOf(date.raw) - 50),
        text.indexOf(date.raw) + 50
      ).toLowerCase()
      
      if (context.includes('exp') || context.includes('expires')) {
        extracted.expiration_date = {
          value: date.iso,
          confidence: 0.85,
        }
        break
      }
    }
    
    // If no labeled DOB found, assume first date is DOB
    if (!extracted.dob && dates.length > 0) {
      extracted.dob = {
        value: dates[0].iso,
        confidence: 0.7,
      }
    }
  }
  
  // Extract name - usually one of the first capitalized lines
  const names = extractNamePatterns(text)
  if (names.length > 0) {
    // Look for name near the top of the document
    const topText = lines.slice(0, 10).join(' ')
    const topNames = extractNamePatterns(topText)
    
    if (topNames.length > 0) {
      extracted.full_name = {
        value: topNames[0].raw,
        confidence: 0.85,
      }
    } else {
      extracted.full_name = {
        value: names[0].raw,
        confidence: 0.7,
      }
    }
  }
  
  // Extract address
  const addresses = extractAddresses(text)
  if (addresses.length > 0) {
    const addr = addresses[0]
    extracted.address_line1 = {
      value: `${addr.number} ${addr.street}`,
      confidence: addr.confidence,
    }
    if (addr.city) {
      extracted.city = {
        value: addr.city,
        confidence: addr.confidence,
      }
    }
    extracted.state = {
      value: addr.state,
      confidence: addr.confidence,
    }
    extracted.zip = {
      value: addr.zip,
      confidence: addr.confidence,
    }
  } else {
    // Try to extract state and zip separately
    const states = extractStates(text)
    if (states.length > 0) {
      extracted.state = {
        value: states[0].raw,
        confidence: states[0].confidence,
      }
    }
    
    const zips = extractZipCodes(text)
    if (zips.length > 0) {
      extracted.zip = {
        value: zips[0].raw,
        confidence: zips[0].confidence,
      }
    }
  }
  
  return extracted
}

export default extractDriversLicense
import { parseAddress } from './helpers.js'

const NAME_REGEX = /((?:[A-Z][a-z]+(?:\s|,))+[A-Z][a-z]+)/i
const DOB_REGEX = /(dob|date of birth)\s*[:\-]?\s*([0-9]{2}[\/\-][0-9]{2}[\/\-][0-9]{2,4})/i
const LICENSE_REGEX = /(license|lic|dln|id)\s*(number|no\.?)?\s*[:\-]?\s*([A-Z0-9\-]+)/i

export function sanitizeDate(raw) {
  if (!raw) return null
  const cleaned = raw.trim().replace(/[^\d/]/g, '')
  if (!cleaned) return null
  const parts = cleaned.split(/[\/\-]/)
  if (parts.length < 3) return null
  const [mm, dd, yy] = parts
  const year = yy.length === 2 ? `19${yy}` : yy
  const iso = `${year.padStart(4, '0')}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
  return iso
}

export async function extractDriversLicense(text = '') {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const joined = lines.join(' ')

  const nameMatch = joined.match(NAME_REGEX)
  const dobMatch = joined.match(DOB_REGEX)
  const licenseMatch = joined.match(LICENSE_REGEX)

  const address = parseAddress(lines)

  return {
    profile: {
      full_name: nameMatch ? nameMatch[1].replace(/\s+/g, ' ').trim() : null,
      dob: dobMatch ? sanitizeDate(dobMatch[2]) : null,
      address_line1: address?.line1 ?? null,
      address_line2: address?.line2 ?? null,
      city: address?.city ?? null,
      state: address?.state ?? null,
      zip: address?.zip ?? null,
      license_number: licenseMatch ? licenseMatch[3] : null,
    },
    rawText: text,
  }
}
