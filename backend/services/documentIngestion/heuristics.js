/**
 * Deterministic profile-section extractors for uploaded documents.
 *
 * Why this file exists (Mission goals 2, 3, 9):
 *   - Goal 2 (match actual needs) and Goal 3 (use the full profile)
 *     require we capture every signal a document provides, especially
 *     identifiers and program enrollment that change which funding the
 *     applicant qualifies for. Missing a Medicaid number means we
 *     cannot link a person to TennCare / ECF CHOICES specific
 *     resources, even though that linkage is the entire reason they
 *     uploaded the card.
 *   - Goal 9 (explainable + reliable) demands deterministic extraction
 *     so the same card always produces the same fields, regardless of
 *     LLM availability. The LLM-based pass remains, but it sits on top
 *     of a deterministic floor that always runs and is testable.
 *
 * The heuristics here are intentionally permissive about *labels*
 * (any of "Medicaid Number", "Recipient ID", "TennCare ID",
 * "Beneficiary No", "Cardholder ID", "Subscriber ID", "Member ID/#",
 * "ID #/No.") and conservative about *values* — we only emit a field
 * when the candidate string looks like a real identifier (mixed
 * alphanumerics, no whitespace, plausible length).
 */

/* ----------------------------------------------------------------- */
/* Shared helpers                                                    */
/* ----------------------------------------------------------------- */

/**
 * Trim trailing whitespace plus any of `extraChars`, in LINEAR time.
 *
 * WHY NOT A REGEX (js/polynomial-redos class, 2026-08-01). An anchored
 * trailing-class trim like `/[\s.;]+$/` is quadratic on a long non-matching
 * run: the engine retries the match at every start position, and each attempt
 * walks to the end. Uploaded documents are the clearest unbounded, untrusted
 * input this codebase has — an OCR/PDF extract of a blank column is a single
 * line of thousands of spaces. Measured on `extractBasicInformationHeuristics`
 * with one long blank line: 4k chars 13.8 ms, 8k 51.7 ms, 16k 198.2 ms
 * (14.4x for 4x the input — quadratic).
 *
 * A character-walk from the end is O(trimmed length) and cannot backtrack.
 * `trimEnd()` is preferred where only whitespace is being removed — it is
 * native, linear, and matches the same character set JS `\s` does.
 *
 * CALL-SITE NOTE that generalises: the danger is the pattern AND its input.
 * The `Plan type` / `Plan name` / `Insurance provider` patterns in this file
 * carry the same `\s*[:#-]?\s*` overlap but are NOT exposed, because their
 * caller matches against `singleLine`, which has already collapsed whitespace
 * runs. Measuring a regex literal in isolation over-reports; measuring the
 * exported function is ground truth.
 */
export function stripTrailing(value, extraChars = '') {
  const s = String(value ?? '')
  const extra = new Set(extraChars)
  let end = s.length
  while (end > 0) {
    const ch = s[end - 1]
    if (extra.has(ch) || /\s/.test(ch)) end -= 1
    else break
  }
  return end === s.length ? s : s.slice(0, end)
}

export function extractFirstMatch(text, regex) {
  if (!text) return null
  const match = String(text).match(regex)
  const value = match?.[1] ?? match?.[0]
  const normalized = typeof value === 'string' ? value.trim() : null
  return normalized || null
}

export function extractLabeledValue(text, labelRegex) {
  // e.g. /(?:EIN|Tax ID)\s*[:#-]\s*([0-9-]{9,})/i
  if (!text) return null
  const regex = new RegExp(`${labelRegex.source}\\s*[:#\\-]?\\s*([^\\n\\r]{2,80})`, labelRegex.flags)
  const m = String(text).match(regex)
  const value = m?.[1]?.trim()
  return value || null
}

/** True if `value` looks like a card / record identifier. */
export function isLikelyIdentifier(value, { min = 5, max = 40 } = {}) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return false
  if (raw.length < min || raw.length > max) return false
  if (/\s/.test(raw)) return false
  if (!/[0-9]/.test(raw)) return false
  if (!/^[A-Za-z0-9-]+$/.test(raw)) return false
  return true
}

/** Pull the first identifier-shaped token from a free-text remainder. */
export function extractIdFromRemainder(remainder, { min = 6, max = 40 } = {}) {
  if (!remainder) return null
  const re = new RegExp(`([A-Za-z0-9-]{${min},${max}})`)
  const m = String(remainder).match(re)
  if (!m) return null
  const candidate = m[1]
  return isLikelyIdentifier(candidate, { min, max }) ? candidate : null
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/** Convert a date string into ISO `YYYY-MM-DD`. Returns null on failure. */
export function parseDateToISO(value) {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw) return null

  // ISO already (allow optional time suffix like "T00:00:00Z" — `\b`
  // would FAIL between a digit and `T` since both are word chars).
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/)
  if (m) {
    const [, y, mo, d] = m
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // MM/DD/YYYY or M/D/YYYY  (US-style; the only style we see on TN
  // benefit documents and ID cards.)
  m = raw.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/)
  if (m) {
    const [, mo, d, y] = m
    let year = y
    if (year.length === 2) year = `19${year}` // be conservative, still useful
    return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // "October 11, 1964"
  m = raw.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/)
  if (m) {
    const [, monthName, day, year] = m
    const idx = MONTH_NAMES.indexOf(monthName.toLowerCase())
    if (idx >= 0) {
      return `${year}-${String(idx + 1).padStart(2, '0')}-${day.padStart(2, '0')}`
    }
  }

  return null
}

/* ----------------------------------------------------------------- */
/* Medicaid / Medicare context detection                             */
/* ----------------------------------------------------------------- */

// Brand / program names that signal the document is a Medicaid artifact.
// Includes TennCare (TN), MassHealth (MA), Medi-Cal (CA), Apple Health
// (WA), MO HealthNet (MO), KanCare (KS), NJ FamilyCare (NJ), Husky
// Health (CT), as well as common managed-care plan brands carried by
// state Medicaid programs.
export const MEDICAID_PROGRAM_RE =
  /\b(?:Medicaid|TennCare|TN[\s-]?Care|MassHealth|Medi[\s-]?Cal|Apple\s+Health|MO\s+HealthNet|KanCare|NJ\s+FamilyCare|Husky\s+Health|HealthChoice|Sooner\s*Care|Iowa\s+Health\s+Link)\b/i

export const MEDICAID_PLAN_BRAND_RE =
  /\b(?:BlueCare(?:\s+TennCare)?|Amerigroup(?:\s+TennCare)?|Wellpoint(?:\s+Medicaid)?|UnitedHealthcare\s+Community\s+Plan|Humana\s+Healthy\s+Horizons|Molina\s+Healthcare|Centene|Anthem\s+Medicaid|CareSource)\b/i

export const ECF_CHOICES_RE = /\bE\s*C\s*F\s*CHOICES\b|\bECF\s*CHOICES\b|\bEmployment\s+(?:&|and)\s+Community\s+First\s+CHOICES\b/i
export const TENNCARE_CHOICES_RE = /\b(?:TennCare\s+)?CHOICES\b/i
export const HCBS_WAIVER_RE = /\bHCBS\s+(?:waiver|Waiver)\b|\bHome\s+and\s+Community[\s-]Based\s+Services\b/i

export const MEDICARE_PROGRAM_RE = /\bMedicare(?:\s+Advantage)?\b|\bMAPD\b|\bPart\s+[ABCD]\b/i

export function detectMedicaidContext(text) {
  const source = String(text || '')
  return (
    MEDICAID_PROGRAM_RE.test(source) ||
    MEDICAID_PLAN_BRAND_RE.test(source) ||
    ECF_CHOICES_RE.test(source) ||
    HCBS_WAIVER_RE.test(source)
  )
}

export function detectMedicareContext(text) {
  return MEDICARE_PROGRAM_RE.test(String(text || ''))
}

/* ----------------------------------------------------------------- */
/* basic_information                                                 */
/* ----------------------------------------------------------------- */

// Words we accept as the suffix of a US street address. Conservative on
// purpose — we'd rather miss an obscure abbreviation than turn the line
// "Mission: Support and expand…" into a street.
const STREET_SUFFIX_RE =
  /(?:Street|St|Drive|Dr|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Way|Court|Ct|Terrace|Ter|Place|Pl|Highway|Hwy|Parkway|Pkwy|Trail|Trl|Circle|Cir|Square|Sq)\.?/i

const STREET_LINE_RE = new RegExp(
  `^(\\d{1,6}\\s+[A-Z0-9][A-Za-z0-9. '-]*(?:\\s+[A-Z0-9][A-Za-z0-9. '-]*)*\\s+${STREET_SUFFIX_RE.source})\\s*\\.?\\s*$`,
  'i',
)

// Postal line: "Cleveland TN 37312", "Anytown, CA 90210", "Cleveland, TN 37312-1234".
const CITY_STATE_ZIP_RE =
  /^([A-Z][A-Za-z .'-]+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/

/**
 * Extract street address and (when present on the next line) city / state /
 * zip from `lines`. Returns `{ address, city, state, zip, addressLineIdx }`
 * with empty strings for missing pieces.
 *
 * Strategy:
 *   1. Find the first standalone STREET_LINE_RE match. The line immediately
 *      after it is the postal line, if it matches CITY_STATE_ZIP_RE.
 *   2. If no clean street line exists, fall back to a labeled "Address:"
 *      line. We strip:
 *        - leading list bullets ("- ", "• ")
 *        - "/phone:" and similar compound-label noise
 *        - everything after the first ',' / ';' so we don't grab the city
 *          / phone tail in single-line "Address/phone: 850 ..., …; (423)…"
 *      and only accept the cleaned value if it still looks like a street.
 *   3. Postal info found on any line via CITY_STATE_ZIP_RE wins as a last
 *      resort — better to surface partial location data than nothing.
 */
function extractStreetAndPostal(source, lines) {
  let address = ''
  let addressLineIdx = -1

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(STREET_LINE_RE)
    if (m) {
      address = m[1].trim().replace(/\.$/, '')
      addressLineIdx = i
      break
    }
  }

  if (!address) {
    const labeled = extractLabeledValue(source, /(?:^|\n)\s*(?:-\s*)?(?:mailing\s+)?address\b/i)
    if (labeled) {
      let cleaned = labeled
        .replace(/^[\s•:>-]+/, '')
        .replace(/\/phone\b.*$/i, '')
        .replace(/[;,].*$/, '')
        .trim()
      if (/^\d{1,6}\s+\S/.test(cleaned)) {
        address = cleaned
        const idx = lines.findIndex((l) => l.includes(cleaned))
        if (idx >= 0) addressLineIdx = idx
      }
    }
  }

  let city = ''
  let state = ''
  let zip = ''

  if (addressLineIdx >= 0 && addressLineIdx + 1 < lines.length) {
    const m = lines[addressLineIdx + 1].match(CITY_STATE_ZIP_RE)
    if (m) {
      city = m[1].trim()
      state = m[2]
      zip = m[3]
    }
  }
  if (!city) {
    for (const line of lines) {
      const m = line.match(CITY_STATE_ZIP_RE)
      if (m) {
        city = m[1].trim()
        state = m[2]
        zip = m[3]
        break
      }
    }
  }

  return { address, city, state, zip, addressLineIdx }
}

/**
 * Pull a multi-word organisation / person name from the first ~10 lines.
 *
 * Skips:
 *   - Single-character placeholders ("X")
 *   - URLs, email addresses, lines that begin with a digit or punctuation
 *   - The address line itself
 *   - Boilerplate "Filed/Prepared from public sources only" disclaimers
 *
 * Strips a trailing parenthetical "(Cleveland High School / CCS)" so we
 * keep "Cleveland High School Blue Raider Marching Band" cleanly.
 */
function extractFullNameHeuristic(lines) {
  const skipRe =
    /^(?:filed|prepared|public information|key public facts|key facts|verify|--?\s*\d|page\s+\d)/i

  for (let i = 0; i < Math.min(lines.length, 10); i += 1) {
    const raw = lines[i]
    if (!raw) continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (/^x$/i.test(trimmed)) continue
    if (/^https?:\/\//i.test(trimmed)) continue
    if (/@/.test(trimmed)) continue
    if (/^[\d(]/.test(trimmed)) continue
    if (skipRe.test(trimmed)) continue
    if (STREET_LINE_RE.test(trimmed)) continue
    if (CITY_STATE_ZIP_RE.test(trimmed)) continue

    const parenStripped = trimmed
      .replace(/\s*\(.*?\)\s*$/, '')
      // Was `/\s*[/|].*$/`. The leading `\s*` is redundant — the `.trim()` on the
      // next line removes the same whitespace — but it makes the match quadratic
      // on a long run with no `/` or `|` (an OCR/PDF extract of a blank column),
      // because `\s*` is retried at every start position. Dropping it is
      // behaviour-identical after the trim and linear.
      .replace(/[/|].*$/, '')
      .trim()
    const words = parenStripped.split(/\s+/).filter(Boolean)
    if (words.length < 3 || words.length > 12) continue
    const capCount = words.filter((w) => /^[A-Z][A-Za-z'.-]*$/.test(w)).length
    if (capCount < Math.ceil(words.length * 0.6)) continue
    return parenStripped
  }
  return ''
}

export function extractBasicInformationHeuristics(text) {
  const source = String(text || '')
  // `trimEnd()` not `/\s+$/` — see the ReDoS note on stripTrailing() below.
  // This map runs over EVERY line of an uploaded document, so it is the single
  // hottest instance of the trailing-trim class in this file.
  const lines = source.split(/\r?\n/).map((l) => l.trimEnd())

  const email = extractFirstMatch(source, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  const phone = extractFirstMatch(
    source,
    /(\+?1[\s.-]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/,
  )
  const websiteRaw = extractFirstMatch(source, /\bhttps?:\/\/[^\s)]+/i)
  // Strip trailing punctuation/whitespace that can leak in from
  // semicolon-delimited URL lists ("https://…org ; https://…com").
  const website = websiteRaw ? stripTrailing(websiteRaw, ');,.') : ''

  // Address / city / state / zip — prefer a standalone street line.
  const { address, city, state, zip } = extractStreetAndPostal(source, lines)

  // Full name — try labelled value first, fall back to a multi-word
  // capitalised-word heuristic on the first ~10 lines.
  //
  // The bare `name` label is intentionally listed because uploaded forms
  // commonly use "Name: <value>" (without "Full"). The heuristic-fallback
  // path mistakes a "Name: Smoke User" line for an organisation name and
  // returns "Name: Smoke User" verbatim, so we have to catch the labelled
  // form first.
  const labeledFullName = extractLabeledValue(
    source,
    /(?:full\s+name|patient\s+name|member\s+name|recipient\s+name|applicant|name)\b/i,
  )
  let fullName = labeledFullName ? labeledFullName.trim() : ''
  if (!fullName) {
    fullName = extractFullNameHeuristic(lines)
  }

  // DOB — many label variants; convert to ISO.
  const dobLabelMatch =
    extractLabeledValue(source, /(?:date\s+of\s+birth|d\.?o\.?b\.?|birth\s*date|birthdate)\b/i) ||
    extractFirstMatch(source, /\b(?:DOB|D\.O\.B\.|Date\s+of\s+Birth|Birthdate|Birth\s*Date)\b\s*[:#-]?\s*([0-9A-Za-z/.,\s-]{6,30})/i)
  const dobISO = parseDateToISO(dobLabelMatch)

  return {
    full_name: fullName || '',
    email: email || '',
    phone: phone || '',
    website: website || '',
    address: address || '',
    city: city || '',
    state: state || '',
    zip: zip || '',
    date_of_birth: dobISO || '',
    notes: '',
  }
}

/* ----------------------------------------------------------------- */
/* organization_details                                              */
/* ----------------------------------------------------------------- */

export function extractOrganizationDetailsHeuristics(text) {
  const source = String(text || '')

  // Generic numeric EIN line (e.g. "62-6000265 (CCS; verify) LAB4BVJDQ7U7
  // 4ZY55") — when no explicit EIN/Tax ID label is present.
  const einPattern =
    extractFirstMatch(source, /(?:\bEIN\b|\bTax\s*ID\b)[^0-9]*([0-9]{2}-[0-9]{7})/i) ||
    extractLabeledValue(source, /\bEIN\b/i) ||
    extractFirstMatch(source, /\b([0-9]{2}-[0-9]{7})\b/)

  const uei =
    extractFirstMatch(source, /(?:\bUEI\b|\bUnique\s+Entity\s+ID\b)[^A-Z0-9]*([A-Z0-9]{12})/i) ||
    extractLabeledValue(source, /\bUEI\b/i) ||
    extractFirstMatch(source, /\b([A-Z][A-Z0-9]{11})\b/)

  const cage =
    extractFirstMatch(source, /(?:\bCAGE\b|\bCAGE\s*Code\b)[^A-Z0-9]*([A-Z0-9]{5})/i) ||
    extractLabeledValue(source, /\bCAGE(?:\s*Code)?\b/i)

  // Mission — accept either an explicit "Mission:" label or a
  // free-text sentence that begins with the verb pattern we emit on
  // the curated profiles (e.g. "Support and expand …").
  let mission =
    extractLabeledValue(source, /(?:^|\n)\s*(?:mission(?:\s+statement)?|purpose)\b/i) || ''
  mission = mission ? stripTrailing(mission, '.;').trim() : ''

  return {
    organization_type: '',
    ein: einPattern || '',
    uei: uei || '',
    cage_code: cage || '',
    annual_budget: null,
    staff_count: null,
    mission,
  }
}

/* ----------------------------------------------------------------- */
/* medical_insurance                                                 */
/* ----------------------------------------------------------------- */

/**
 * Per-line label resolver. Many ID cards put the label and value on
 * the same line ("Member ID:  999888777"); some put them on two lines.
 * We try the line-anchored regex first, then fall back to a single-line
 * re-flow of the document.
 */
function findLabeledIdentifier(text, labelRegexes, { minLen = 6 } = {}) {
  const raw = String(text || '')
  const single = raw.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

  for (const labelRe of labelRegexes) {
    // Anchored: start of line, label, optional separator, then value.
    const lineRe = new RegExp(
      `(?:^|[\\r\\n])\\s*${labelRe.source}\\s*[:#\\-]?\\s*([^\\r\\n]+)`,
      labelRe.flags,
    )
    const lineMatch = raw.match(lineRe)
    const lineId = extractIdFromRemainder(lineMatch?.[1], { min: minLen, max: 40 })
    if (lineId) return lineId

    // Single-line fallback (handles wrap-around / weird OCR linebreaks).
    const inlineRe = new RegExp(
      `${labelRe.source}\\s*[:#\\-]?\\s*([A-Za-z0-9-]{${minLen},40})\\b`,
      labelRe.flags,
    )
    const inlineMatch = single.match(inlineRe)
    if (inlineMatch?.[1] && isLikelyIdentifier(inlineMatch[1], { min: minLen, max: 40 })) {
      return inlineMatch[1].trim()
    }
  }
  return null
}

// Labels that mean "this is the Medicaid / TennCare / Medicare member
// number". Order matters — most specific first so we don't confuse
// group/policy IDs with member IDs.
export const MEMBER_ID_LABELS = [
  /\bMedicaid\s+Recipient\s+(?:ID|Number|No\.?|#)\b/i,
  /\bMedicaid\s+Member\s+(?:ID|Number|No\.?|#)\b/i,
  /\bMedicaid\s+(?:Number|No\.?|ID|#)\b/i,
  /\bTennCare\s+(?:ID|Number|No\.?|#)\b/i,
  /\bTennCare\s+Member\s+(?:ID|Number|No\.?|#)\b/i,
  /\bRecipient\s+(?:ID|Number|No\.?|#)\b/i,
  /\bBeneficiary\s+(?:ID|Number|No\.?|#)\b/i,
  /\bCardholder\s+(?:ID|Number|No\.?|#)\b/i,
  /\bSubscriber\s+(?:ID|Number|No\.?|#)\b/i,
  /\bEnrollee\s+(?:ID|Number|No\.?|#)\b/i,
  /\bMember\s+(?:ID|Number|No\.?|#)\b/i,
  /\bID\s+(?:Number|No\.?|#)\b/i,
]

export const GROUP_ID_LABELS = [
  /\bGroup\s+(?:ID|Number|No\.?|#)\b/i,
  /\bGroup\b/i,
  /\bPolicy\s+(?:ID|Number|No\.?|#)\b/i,
]

export function extractMedicalInsuranceHeuristics(text) {
  const raw = String(text || '')
  if (!raw) {
    return {
      insurance_provider: '',
      plan_name: '',
      plan_type: '',
      member_id: '',
      group_id: '',
      effective_date: '',
    }
  }
  const singleLine = raw.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  const isMedicaid = detectMedicaidContext(raw)
  const isMedicare = detectMedicareContext(raw)

  const memberId = findLabeledIdentifier(raw, MEMBER_ID_LABELS, { minLen: 6 })
  const groupId = findLabeledIdentifier(raw, GROUP_ID_LABELS, { minLen: 4 })

  const explicitProvider =
    extractLabeledValue(raw, /\bInsurance\s+provider\b/i) ||
    extractFirstMatch(singleLine, /\bInsurance\s+provider\b\s*[:#-]?\s*([A-Za-z][A-Za-z0-9 .,'/-]{2,60})/i)
  const brand = extractFirstMatch(raw, MEDICAID_PLAN_BRAND_RE) || null
  const programName = extractFirstMatch(raw, MEDICAID_PROGRAM_RE) || null
  const provider = explicitProvider || brand || programName || (isMedicaid ? 'Medicaid' : isMedicare ? 'Medicare' : null)

  const planTypeFromLabel =
    extractFirstMatch(extractLabeledValue(raw, /\bPlan\s+type\b/i) || '', /\b(Medicaid|Medicare|Marketplace|HMO|PPO)\b/i) ||
    extractFirstMatch(singleLine, /\bPlan\s+type\b\s*[:#-]?\s*(Medicaid|Medicare|Marketplace|HMO|PPO)\b/i)
  const planType = planTypeFromLabel || (isMedicaid ? 'Medicaid' : isMedicare ? 'Medicare' : '')

  const planName =
    extractLabeledValue(raw, /\bPlan\s+name\b/i) ||
    extractFirstMatch(singleLine, /\bPlan\s+name\b\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9 .,'/-]{2,80})/i) ||
    null

  const effectiveRaw =
    extractLabeledValue(raw, /\bEffective(?:\s+(?:Date|On))?\b/i) ||
    extractFirstMatch(singleLine, /\bEffective(?:\s+(?:Date|On))?\b\s*[:#-]?\s*([0-9A-Za-z/.,\s-]{6,30})/i)
  const effectiveISO = parseDateToISO(effectiveRaw)

  return {
    insurance_provider: provider ? String(provider).replace(/\bPlan\s+name\b.*$/i, '').trim() : '',
    plan_name: planName ? String(planName).replace(/\bPlan\s+type\b.*$/i, '').trim() : '',
    plan_type: planType || '',
    member_id: memberId || '',
    group_id: groupId || '',
    effective_date: effectiveISO || '',
  }
}

/* ----------------------------------------------------------------- */
/* government_assistance                                             */
/* ----------------------------------------------------------------- */

/**
 * Extract benefit-program enrollment from a document so the matcher
 * can treat the applicant as a recipient even before AI parses the
 * narrative. Defaults to NEUTRAL (omit fields) — never set a flag to
 * `false` when the document is silent. (Mission rule: missing
 * profile fields default to neutral, not exclusionary.)
 */
export function extractGovernmentAssistanceHeuristics(text) {
  const source = String(text || '')
  const out = {}
  const programs = []

  if (detectMedicaidContext(source)) {
    out.medicaid_recipient_self = true
    if (MEDICAID_PROGRAM_RE.test(source)) {
      const program = extractFirstMatch(source, MEDICAID_PROGRAM_RE)
      if (program) programs.push(program)
    }
    if (MEDICAID_PLAN_BRAND_RE.test(source)) {
      const brand = extractFirstMatch(source, MEDICAID_PLAN_BRAND_RE)
      if (brand) programs.push(brand)
    }
    if (ECF_CHOICES_RE.test(source)) programs.push('ECF CHOICES (TN)')
    else if (TENNCARE_CHOICES_RE.test(source)) programs.push('TennCare CHOICES')
    if (HCBS_WAIVER_RE.test(source)) programs.push('HCBS Waiver')
  }

  if (detectMedicareContext(source)) {
    out.medicare_recipient_self = true
    programs.push(extractFirstMatch(source, MEDICARE_PROGRAM_RE) || 'Medicare')
  }

  // SSI / SSDI / SNAP / TANF / Section 8 — only set when the document
  // explicitly references the program name. Language like "applied
  // for" is ambiguous, so we require enrollment-style verbs OR the
  // program name appearing as a label / award statement.
  if (/\b(?:SSI|Supplemental\s+Security\s+Income)\b/i.test(source)) {
    out.ssi_recipient_self = true
    programs.push('SSI')
  }
  if (/\bSSDI\b|\bSocial\s+Security\s+Disability\s+Insurance\b/i.test(source)) {
    out.ssdi_recipient_self = true
    programs.push('SSDI')
  }
  if (/\bSNAP\b|\bSupplemental\s+Nutrition\s+Assistance\s+Program\b|\bFood\s+Stamps?\b/i.test(source)) {
    out.snap_recipient_self = true
    programs.push('SNAP')
  }
  if (/\bTANF\b|\bTemporary\s+Assistance\s+for\s+Needy\s+Families\b/i.test(source)) {
    out.tanf_recipient_self = true
    programs.push('TANF')
  }
  if (/\bSection\s*8\b|\bHousing\s+Choice\s+Voucher\b/i.test(source)) {
    out.section8_recipient_self = true
    programs.push('Section 8 (HCV)')
  }

  if (programs.length > 0) {
    // Dedupe (case-insensitive) while preserving order.
    const seen = new Set()
    const deduped = []
    for (const p of programs) {
      const key = p.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(p)
      }
    }
    out.other_programs = deduped.join(', ')
  }

  return out
}
