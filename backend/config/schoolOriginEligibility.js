/** Source-declared school-origin restrictions, never inferred from residence. */
import { normalizeStateCode } from './profileFactTimeline.js'
import { isStudentProfileType } from '../../shared/profileSectionApplicability.js'

const SOURCE_FIELDS = Object.freeze(['eligibility_text', 'eligibility_bullets', 'description'])
const SCHOOL_COUNTY = /\b(?:graduates?\s+(?:of|from)|graduated\s+from)\s+(?:(?:a|an|the|any)\s+)?(?:(public|private)\s+)?high[- ]schools?\s+(?:in|within)\s+(?:the\s+)?([a-z][a-z .'-]{0,70}?)\s+County\b/gi
const COUNTY_GRADUATES = /\bfor\s+([a-z][a-z .'-]{0,70}?)\s+County(?:\s*,\s*([a-z]+(?:\s+[a-z]+){0,2}?))?\s+(?:(public|private)\s+)?high[- ]school\s+graduates?\b/gi
const HISTORICAL = /\b(?:was|were|previous(?:ly)?|formerly|last\s+year|past\s+recipient|donor|founder)\b/i
const NONEXCLUSIVE = /\b(?:not|never|preference|prefer(?:red|ence)?|priority|may|regardless|including|such\s+as)\b/i
const REQUIRED = /\b(?:(?:is|are)\s+for|only|must\s+(?:be|have)|required\s+to\s+(?:be|have)|(?:restricted|limited|open|available|awarded|offered)\s+(?:only\s+)?to|eligible\s+if\s+(?:they|you)(?:\s+are)?)\s*(?:(?:a|an|the|any)\s+)?$/i
const REVERSE_SUBJECT = /^\s*(?:(?:the|a|this)\s+)?(?:scholarship|award|program|fund)s?\s+(?:(?:is|are|will\s+be)\s+)?$/i
const APPLICANT_RELATIVE = /\bonly\s+(?:applicants?|students?|candidates?|recipients?|individuals?|people)\s+(?:who|that)\s+(?:have\s+)?$/i
const APPLICANT_MANDATE = /\b(?:applicants?|students?|candidates?|recipients?|individuals?|you)\s+(?:must|shall|are\s+required\s+to)\s+(?:be|have)\s+([^.!?;]{0,180})$/i
const BENEFICIARY_OR_ALTERNATIVE = /\b(?:or|not|never|organizations?|institutions?|providing|serving|supporting|beneficiaries)\b/i
const HISTORICAL_REPORT_SUFFIX = /^\s*[,;:]?\s*(?:(?:in\s+)?(?:19|20)\d{2}\s+)?(?:was|were|had\s+been|last\s+year|previously|received|won)\b/i
const CURRENT_BINDING = /\b(?:is|are|will)\b[^.!?;]*$/i
const SOFT_SCHOOL_SUFFIX = /^\s*[,;:]?\s*(?:(?:receive|have|get|are\s+given|will\s+receive)\s+(?:a\s+)?(?:preference|priority)|(?:are\s+|will\s+be\s+)?(?:preferred|favou?red)|(?:is|are)\s+(?:not\s+(?:required|mandatory)|optional))\b/i
const WIDENED = /^\s*(?:,\s*)?(?:or\b|(?:and\s+)?(?:surrounding|adjacent|neighbou?ring|other|nearby)\b|(?:and|,|\/|&)\s*[a-z .'-]+\s+count(?:y|ies)\b)/i
const unknown = value => !value || /^(?:unknown|unspecified|not specified|n\/?a|none|prefer not to say)$/i.test(value)
const countyName = value => {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').replace(/\s+(?:county|co)\.?$/i, '').trim().toLowerCase() : ''
  return !unknown(text) && /^[a-z][a-z .'-]{0,70}$/.test(text) ? text : null
}
function objectValue(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
/** UTC keeps fingerprints, database selection and deployed workers on the same boundary. */
export function schoolOriginPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-H${now.getUTCMonth() < 6 ? 1 : 2}`
}
function graduationCompleted(year, now = new Date()) {
  return Boolean(year && (year < now.getUTCFullYear() || (year === now.getUTCFullYear() && now.getUTCMonth() >= 6)))
}
export function normalizeSchoolOrigin(sections, profileOrType = null) {
  const rawType = typeof profileOrType === 'string' ? profileOrType
    : profileOrType?.primary_type ?? profileOrType?.profile_type ?? profileOrType?.applicant_type ?? ''
  const household = /famil|household/i.test(rawType)
  const student = !rawType || isStudentProfileType(rawType)
  const section = objectValue(sections?.education ?? sections?.education_information ?? sections?.student)
  const legacy = objectValue(section.answers ?? section)
  const basicSection = objectValue(sections?.basic_information ?? sections?.basic_info)
  const basic = objectValue(basicSection.answers ?? basicSection)
  const applicant = Object.fromEntries(['county', 'state', 'type', 'graduation_year'].map(suffix =>
    [`high_school_${suffix}`, basic[`applicant_high_school_${suffix}`]]))
  const populated = block => Object.values(block).some(value => value !== null && value !== undefined && String(value).trim() !== '')
  const explicitOrLegacy = Object.fromEntries(Object.keys(applicant).map(key => {
    const value = applicant[key]
    return [key, value !== null && value !== undefined && String(value).trim() !== '' ? value : legacy[key]]
  }))
  const education = household ? applicant : student
    ? (populated(Object.fromEntries(Object.entries(legacy).filter(([key]) => key.startsWith('high_school_')))) ? legacy : applicant)
    : explicitOrLegacy
  const fieldPrefix = student && !household ? 'education.high_school_' : 'basic_information.applicant_high_school_'
  const type = String(education.high_school_type ?? '').trim().toLowerCase()
  const year = Number(education.high_school_graduation_year)
  return {
    fieldPrefix,
    county: countyName(education.high_school_county),
    state: normalizeStateCode(education.high_school_state),
    type: ['public', 'private'].includes(type) ? type : null,
    graduationYear: Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null,
    graduationCompleted: Number.isInteger(year) && year >= 1900 && year <= 2200 && graduationCompleted(year),
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
  if (!match) return { state: null, remainder: after }
  const words = [...match[1].matchAll(/[a-z]+/gi)].slice(0, 3)
  for (let count = words.length; count > 0; count -= 1) {
    const state = normalizeStateCode(words.slice(0, count).map(word => word[0]).join(' '))
    if (state) {
      const last = words[count - 1]
      const consumed = match[0].length - match[1].length + last.index + last[0].length
      return { state, remainder: after.slice(consumed) }
    }
  }
  return { state: null, remainder: after }
}
/** Preserve mandatory scope across applicant-relative and conjoined conditions only. */
function applicantClause(before) {
  const relative = before.match(APPLICANT_RELATIVE)
  if (relative) return before.slice(relative.index)
  const mandate = before.match(APPLICANT_MANDATE)
  if (!mandate) return null
  const intervening = mandate[1]
  if (BENEFICIARY_OR_ALTERNATIVE.test(intervening)) return null
  if (intervening.trim() && !/\band\s+(?:(?:be|have)\s+)?$/i.test(intervening)) return null
  return before.slice(mandate.index)
}
export function schoolOriginRequirements(row) {
  const requirements = []
  const blindEvidenceRecord = (row?.source_id === 'web_search' || row?.source === 'web_search') && ((row?.page_fact_schema_version !== null && row?.page_fact_schema_version !== undefined) || objectValue(row?.raw).blind_extraction === true)
  const sourceFields = blindEvidenceRecord ? SOURCE_FIELDS.filter(field => field.startsWith('eligibility_')) : SOURCE_FIELDS
  for (const field of sourceFields) {
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
        const stateSuffix = explicitState(after)
        const applicant = applicantClause(before)
        const qualifierContext = applicant ?? before
        const historical = !applicant && HISTORICAL.test(before) && !CURRENT_BINDING.test(before)
        const subjectBound = candidate.reverse
          ? (field.startsWith('eligibility_') && !before.trim()) || REVERSE_SUBJECT.test(before)
          : Boolean(applicant) || standaloneBullet || REQUIRED.test(before)
        if (!subjectBound || NONEXCLUSIVE.test(qualifierContext) || historical || (HISTORICAL_REPORT_SUFFIX.test(after) || HISTORICAL_REPORT_SUFFIX.test(stateSuffix.remainder)) || SOFT_SCHOOL_SUFFIX.test(after) || SOFT_SCHOOL_SUFFIX.test(stateSuffix.remainder) || WIDENED.test(after) || WIDENED.test(stateSuffix.remainder)) continue
        const county = countyName(candidate.county)
        if (county) requirements.push({ county, state: candidate.reverse ? candidate.state : stateSuffix.state, type: candidate.type?.toLowerCase() ?? null, field, evidence: sentence.trim() })
      }
    }
  }
  return requirements.filter((value, index) => requirements.findIndex(other => other.county === value.county && other.state === value.state && other.type === value.type) === index)
}

/** A requirement can be unconfirmed without asserting that the applicant fails it. */
export function evaluateSchoolOrigin(origin, requirements, now = new Date()) {
  const ineligibilityReasons = [], missingFields = []
  const fieldPrefix = origin?.fieldPrefix ?? 'education.high_school_'
  for (const rule of requirements ?? []) {
    const year = origin?.graduationYear
    const completed = graduationCompleted(year, now)
    if (!completed) missingFields.push(fieldPrefix + 'graduation_year')
    if (!origin?.county) missingFields.push(fieldPrefix + 'county')
    else if (completed && origin.county !== rule.county) ineligibilityReasons.push(`Requires graduation from a high school in ${rule.county} County; declared high school is in ${origin.county} County`)
    if (rule.state) {
      if (!origin?.state) missingFields.push(fieldPrefix + 'state')
      else if (completed && origin.state !== rule.state) ineligibilityReasons.push(`Requires high-school graduation in ${rule.state}; declared high school is in ${origin.state}`)
    }
    if (rule.type) {
      if (!origin?.type) missingFields.push(fieldPrefix + 'type')
      else if (completed && origin.type !== rule.type) ineligibilityReasons.push(`Requires graduation from a ${rule.type} high school; declared school type is ${origin.type}`)
    }
  }
  return { ineligibilityReasons: [...new Set(ineligibilityReasons)], missingFields: [...new Set(missingFields)] }
}
