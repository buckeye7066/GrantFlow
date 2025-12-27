import {
  extractEmails,
  extractPhones,
  extractAddresses,
  normalizeText,
} from './common.js'

/**
 * Extract data from scholarship letter
 * Extracts funding source information
 */
export function extractScholarshipLetter(text) {
  const normalized = normalizeText(text)
  const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean)
  
  const extracted = {
    funding_source_name: null,
    contact_email: null,
    contact_phone: null,
    address: null,
    award_amount: null,
  }
  
  // Extract organization name - usually in the header/letterhead
  // Look for lines that might be organization names (typically first few lines)
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i]
    // Skip very short lines and common salutations
    if (line.length > 10 && 
        !line.toLowerCase().startsWith('dear') &&
        !/^\d+$/.test(line) && // Skip pure numbers
        !/^[A-Z]{2}$/.test(line) // Skip state abbreviations
    ) {
      // Check if it contains keywords suggesting organization
      if (line.match(/foundation|scholarship|fund|trust|society|association|university|college/i)) {
        extracted.funding_source_name = {
          value: line,
          confidence: 0.85,
        }
        break
      }
    }
  }
  
  // If no org name found with keywords, use first substantial line
  if (!extracted.funding_source_name && lines.length > 0) {
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      const line = lines[i]
      if (line.length > 15 && line.length < 100) {
        extracted.funding_source_name = {
          value: line,
          confidence: 0.6,
        }
        break
      }
    }
  }
  
  // Extract contact information
  const emails = extractEmails(text)
  if (emails.length > 0) {
    extracted.contact_email = {
      value: emails[0].normalized,
      confidence: emails[0].confidence,
    }
  }
  
  const phones = extractPhones(text)
  if (phones.length > 0) {
    extracted.contact_phone = {
      value: phones[0].formatted,
      confidence: phones[0].confidence,
    }
  }
  
  const addresses = extractAddresses(text)
  if (addresses.length > 0) {
    const addr = addresses[0]
    extracted.address = {
      value: addr.raw,
      confidence: addr.confidence,
      structured: {
        line1: `${addr.number} ${addr.street}`,
        city: addr.city,
        state: addr.state,
        zip: addr.zip,
      },
    }
  }
  
  // Extract award amount - look for dollar amounts
  const amountPattern = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g
  const amounts = [...text.matchAll(amountPattern)]
  
  if (amounts.length > 0) {
    // Find the largest amount mentioned (likely the award)
    let maxAmount = 0
    let maxAmountStr = ''
    
    for (const match of amounts) {
      const amountStr = match[1].replace(/,/g, '')
      const amount = parseFloat(amountStr)
      if (amount > maxAmount) {
        maxAmount = amount
        maxAmountStr = match[0]
      }
    }
    
    if (maxAmount > 0) {
      extracted.award_amount = {
        value: maxAmount,
        formatted: maxAmountStr,
        confidence: 0.75,
      }
    }
  }
  
  return extracted
}

export default extractScholarshipLetter
