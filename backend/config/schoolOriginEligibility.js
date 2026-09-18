/** Source-declared school-origin restrictions, never inferred from residence. */
import { normalizeStateCode } from './profileFactTimeline.js'

const SOURCE_FIELDS = Object.freeze(['eligibility_text', 'eligibility_bullets', 'description', 'summary'])
const SCHOOL_COUNTY = /\b(?:graduates?\s+(?:of|from)|graduated\s+from)\s+(?:(?:a|an|the|any)\s+)?(?:(public|private)\s+)?high[- ]schools?\s+(?:in|within)\s+(?:the\s+)?([a-z][a-z .'-]{0,70}?)\s+County\b/gi
const COUNTY_GRADUATES = /\bfor\s+([a-z][a-z .'-]{0,70}?)\s+County(?:\s*,\s*([a-z]+(?:\s+[a-z]+){0,2}?))?\s+(?:(public|private)\s+)?high[- ]school\s+graduates?\b/gi
const HISTORICAL = /\b(?:was|were|previous(?:ly)?|formerly|last\s+year|past\s+recipient|donor|founder)\b/i
const NONEXCLUSIVE = /\b(?:not|never|preference|prefer(?:red|ence)?|priority|may|regardless|including|such\s+as)\b/i
const REQUIRED = /\b(?:must|required|restricted|eligible|eligibility|open\s+to|available\s+to|awarded\s+to|offered\s+to)\b/i
const WIDENED = /^\s*(?:,\s*)?(?:or\b|(?:and\s+)?(?:surrounding|adjacent|neighbou?ring|other|nearby)\b|(?:and|,|\/|&)\s*[a-z .'-]+\s+count(?:y|ies)\b)/i
const unknown = value => !value || /^(?:unknown|unspecified|not specified|n\/?a|none|prefer not to say)$/i.test(value)
const countyName = value => {
  const text = typeof value === 'string' ? value.trim().replace(/\s+county$/i, '').trim().toLowerCase() : ''
  return !unknown(text) && /^[a-z][a-z .'-]{0,70}$/.test(text) ? text : null
}
function objectValue(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
export function normalizeSchoolOrigin(sections) {
  const section = objectValue(sections?.education)
  const education = objectValue(section.answers ?? section)
  const type = String(education.high_school_type ?? '').trim().toLowerCase()
  const year = Number(education.high_school_graduation_year)
  return {
    county: countyName(education.high_school_county),
    state: normalizeStateCode(education.high_school_state),
    type: ['public', 'private'].includes(type) ? type : null,
    graduationYear: Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null,
  }
}
function sourceText(value) {
  if (Array.isArray(value)) return value.map(sourceText).join('\n')
  if (typeof value !== 'string') return ''
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return sourceText(parsed)
  } catch { /* ordinary source prose */ }
  return value
}
function explicitState(after) {
  const match = after.match(/^\s*,\s*([a-z .'-]+)/i)
  if (!match) return null
  const words = match[1].trim().split(/\s+/)
  for (let count = Math.min(words.length, 3); count > 0; count -= 1) {
    const state = normalizeStateCode(words.slice(0, count).join(' ').replace(/[.,]+$/, ''))
    if (state) return state
  }
  return null
}
export function schoolOriginRequirements(row) {
  const requirements = []
  for (const field of SOURCE_FIELDS) {
    const sentences = sourceText(row?.[field]).split(/(?<=[.!?])\s+|\n+/)
    for (const sentence of sentences) {
      const candidates = [
        ...Array.from(sentence.matchAll(SCHOOL_COUNTY), match => ({ match, county: match[2], type: match[1], reverse: false })),
        ...Array.from(sentence.matchAll(COUNTY_GRADUATES), match => ({ match, county: match[1], state: normalizeStateCode(match[2]), type: match[3], reverse: true })),
      ]
      for (const candidate of candidates) {
        const { match } = candidate
        const before = sentence.slice(0, match.index)
        const after = sentence.slice(match.index + match[0].length)
        const standaloneBullet = field.startsWith('eligibility_') && /^\s*(?:[-*]|\d+[.)])?\s*$/.test(before)
        if (NONEXCLUSIVE.test(before) || HISTORICAL.test(before) || (!candidate.reverse && !standaloneBullet && !REQUIRED.test(before)) || WIDENED.test(after)) continue
        const county = countyName(candidate.county)
        if (county) requirements.push({ county, state: candidate.reverse ? candidate.state : explicitState(after), type: candidate.type?.toLowerCase() ?? null, field, evidence: sentence.trim() })
      }
    }
  }
  return requirements.filter((value, index) => requirements.findIndex(other => other.county === value.county && other.state === value.state && other.type === value.type) === index)
}

/** A requirement can be unconfirmed without asserting that the applicant fails it. */
export function evaluateSchoolOrigin(origin, requirements, now = new Date()) {
  const ineligibilityReasons = [], missingFields = []
  for (const rule of requirements ?? []) {
    const year = origin?.graduationYear
    const completed = year && (year < now.getFullYear() || (year === now.getFullYear() && now.getMonth() >= 6))
    if (!completed) missingFields.push('education.high_school_graduation_year')
    if (!origin?.county) missingFields.push('education.high_school_county')
    else if (completed && origin.county !== rule.county) ineligibilityReasons.push(`Requires graduation from a high school in ${rule.county} County; declared high school is in ${origin.county} County`)
    if (rule.state) {
      if (!origin?.state) missingFields.push('education.high_school_state')
      else if (completed && origin.state !== rule.state) ineligibilityReasons.push(`Requires high-school graduation in ${rule.state}; declared high school is in ${origin.state}`)
    }
    if (rule.type) {
      if (!origin?.type) missingFields.push('education.high_school_type')
      else if (completed && origin.type !== rule.type) ineligibilityReasons.push(`Requires graduation from a ${rule.type} high school; declared school type is ${origin.type}`)
    }
  }
  return { ineligibilityReasons: [...new Set(ineligibilityReasons)], missingFields: [...new Set(missingFields)] }
}
