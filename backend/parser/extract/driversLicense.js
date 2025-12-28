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
