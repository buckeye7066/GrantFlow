import { parseAddress } from './helpers.js'

const ORG_REGEX = /(foundation|university|college|school|association|committee)[^\n\r]{0,80}/i
const CONTACT_REGEX = /(phone|tel\.?|contact)\s*[:-]?\s*([0-9-()\s]+)/i
const EMAIL_REGEX = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i
const WEBSITE_REGEX = /(https?:\/\/[^\s]+)/i
const AMOUNT_REGEX = /\$[\d,]+(\.\d{2})?/i
const DEADLINE_REGEX = /(deadline|due|submit by)\s*[:-]?\s*([A-Z0-9 ,/-]+)/i
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
