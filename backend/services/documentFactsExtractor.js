function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function firstMatch(text, regex) {
  const m = text.match(regex)
  if (!m) return null
  return (m[1] ?? m[0] ?? '').trim() || null
}

function normalizePhone(raw) {
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return raw.trim()
}

function extractAddressFromLines(lines) {
  // Best-effort: look for "City, ST 12345" then use the previous line as street.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/\b([A-Za-z .'-]+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)\b/)
    if (!m) continue
    const cityStateZip = `${m[1].trim()}, ${m[2].trim()} ${m[3].trim()}`
    const street = lines[i - 1] ? lines[i - 1].trim() : ''
    const street2 = lines[i - 2] ? lines[i - 2].trim() : ''
    // If there's a suite/apt line above street, include it too.
    const suiteLike = /(?:suite|ste\.?|apt\.?|unit|#)\s*\w+/i.test(street) ? street : ''
    const baseStreet = suiteLike ? street2 : street
    const parts = [baseStreet, suiteLike, cityStateZip].filter(Boolean)
    if (parts.length >= 2) return parts.join(', ')
  }
  return null
}

export function extractDocumentFacts(extractedText) {
  const text = typeof extractedText === 'string' ? extractedText : ''
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length < 200)

  const emails = uniq(
    Array.from(text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)).map((m) =>
      m[0]?.trim(),
    ),
  )
  const email = emails[0] ?? null

  const rawPhone =
    firstMatch(text, /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/) ?? null
  const phone = normalizePhone(rawPhone)

  const website =
    firstMatch(text, /\bhttps?:\/\/[^\s)"']+/i) ??
    firstMatch(text, /\bwww\.[^\s)"']+/i)

  // Identifiers
  const einRaw =
    firstMatch(text, /(?:\bEIN\b|\bTax\s*ID\b|\bTIN\b)[^0-9]*(\d{2}-?\d{7})/i) ??
    firstMatch(text, /\b\d{2}-\d{7}\b/)
  const ein =
    einRaw && /^\d{9}$/.test(einRaw.replace(/[^\d]/g, ''))
      ? `${einRaw.replace(/[^\d]/g, '').slice(0, 2)}-${einRaw.replace(/[^\d]/g, '').slice(2)}`
      : einRaw

  const uei = firstMatch(text, /(?:\bUEI\b|\bUnique\s*Entity\s*ID\b)[^A-Z0-9]*([A-Z0-9]{12})/i)
  const cage = firstMatch(text, /(?:\bCAGE\b(?:\s*CODE)?)[^A-Z0-9]*([A-Z0-9]{5})/i)

  const address = extractAddressFromLines(lines)

  return {
    basic_information: {
      email: email ?? '',
      phone: phone ?? '',
      website: website ?? '',
      address: address ?? '',
    },
    organization_details: {
      ein: ein ?? '',
      uei: uei ?? '',
      cage_code: cage ?? '',
    },
    evidence: {
      emails,
    },
  }
}

