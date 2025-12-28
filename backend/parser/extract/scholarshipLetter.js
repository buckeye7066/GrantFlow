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
import { parseAddress } from './helpers.js'

const ORG_REGEX = /(foundation|university|college|school|association|committee)[^\n\r]{0,80}/i
const CONTACT_REGEX = /(phone|tel\.?|contact)\s*[:\-]?\s*([0-9\-\(\)\s]+)/i
const EMAIL_REGEX = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i
const WEBSITE_REGEX = /(https?:\/\/[^\s]+)/i
const AMOUNT_REGEX = /\$[\d,]+(\.\d{2})?/i
const DEADLINE_REGEX = /(deadline|due|submit by)\s*[:\-]?\s*([A-Z0-9 ,\/\-]+)/i
const APPLICANT_REGEX = /(dear|congratulations|recipient)\s+(?:mr\.?|ms\.?|mrs\.)?\s*([A-Z][A-Za-z\s]+)/i

export async function extractScholarshipLetter(text = '') {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const joined = lines.join(' ')

  const orgMatch = joined.match(ORG_REGEX)
  const contactMatch = joined.match(CONTACT_REGEX)
  const emailMatch = joined.match(EMAIL_REGEX)
  const websiteMatch = joined.match(WEBSITE_REGEX)
  const amountMatch = joined.match(AMOUNT_REGEX)
  const deadlineMatch = joined.match(DEADLINE_REGEX)
  const applicantMatch = joined.match(APPLICANT_REGEX)

  const address = parseAddress(lines)

  return {
    profile: {
      full_name: applicantMatch ? applicantMatch[2].trim() : null,
    },
    funding_sources: [
      {
        name: orgMatch ? orgMatch[0].replace(/\s+/g, ' ').trim() : null,
        contact: contactMatch ? contactMatch[2].trim() : null,
        email: emailMatch ? emailMatch[1] : null,
        website: websiteMatch ? websiteMatch[1] : null,
        amount: amountMatch ? amountMatch[0] : null,
        deadline: deadlineMatch ? deadlineMatch[2].trim() : null,
        address,
      },
    ],
    rawText: text,
  }
}
