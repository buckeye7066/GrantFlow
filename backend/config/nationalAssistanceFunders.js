// backend/config/nationalAssistanceFunders.js
//
// A CURATED, VETTED slice of national assistance FUNDERS — the real foundations
// and programs that give money to individuals in need (medication / copay,
// disability, medical hardship, general hardship, senior). Owner rule 2026-08-23:
// "return more, better, real, relatable funding sources that match the needs of
// the profile and that the profile qualifies for."
//
// WHY A DEDICATED SLICE. Measured on prod 2026-08-23: real need-based profiles
// (disabled adult, senior, low-income) surfaced ONLY directories/benefit-finders
// ("211", "benefits.gov finder", "Eldercare Locator") — which by the locator rule
// are recommendable, and NONE of the funds that actually pay. The canonical
// engine, run on those exact pairs, scores PAN / HealthWell / Patient Advocate /
// Modest Needs at REVIEW (score 2-10), NOT ACCEPT, for a genuinely-qualifying
// disabled/senior person — because the data-points score measures how many of a
// profile's ~70 facts a funder's stated criteria match, and a broadly-eligible
// assistance fund states FEW criteria (it gates on a specific condition + income
// AT APPLICATION). An awardable row at REVIEW is not recommendable, so these
// funds never reach the people they exist for.
//
// This registry names the REAL national players, never "any assistance-titled
// row" — that broad set is full of foreign SASSA grants, a job posting, and
// research grants (measured). A catalog row qualifies ONLY when it is NATIONAL +
// AWARDABLE (not a pointer/directory) + its sponsor or title matches a vetted
// identity here. Identity is matched against the row's OWN identity fields
// (sponsor + title) only — never description prose (the #1086 fabricated-phrase
// discipline).

import { isPointerKind } from './opportunityKindClasses.js'

// Canonical need families this slice can serve.
export const ASSISTANCE_NEED = Object.freeze({
  MEDICAL: 'medical',
  DISABILITY: 'disability',
  BASIC_NEEDS: 'basic_needs',
  SENIOR: 'senior',
})

// Each vetted funder: lowercased identity phrases (matched by substring against
// `sponsor | title`) and the need families it serves. Keep phrases DISTINCTIVE
// (a whole funder name or an unmistakable program name) so a coincidental word
// can never pull in an unrelated row.
export const NATIONAL_ASSISTANCE_FUNDERS = Object.freeze([
  { id: 'healthwell', patterns: ['healthwell'], needs: ['medical'] },
  { id: 'pan_foundation', patterns: ['pan foundation', 'patient access network'], needs: ['medical'] },
  { id: 'patient_advocate', patterns: ['patient advocate foundation'], needs: ['medical'] },
  { id: 'good_days', patterns: ['good days', 'chronic disease fund'], needs: ['medical'] },
  { id: 'the_assistance_fund', patterns: ['the assistance fund'], needs: ['medical'] },
  { id: 'cancercare', patterns: ['cancercare', 'cancer care co-payment', 'cancer care copay'], needs: ['medical'] },
  { id: 'family_reach', patterns: ['family reach'], needs: ['medical', 'basic_needs'] },
  { id: 'lls', patterns: ['leukemia & lymphoma society', 'leukemia and lymphoma society'], needs: ['medical'] },
  { id: 'nord', patterns: ['national organization for rare disorders'], needs: ['medical'] },
  { id: 'rx_outreach', patterns: ['rx outreach'], needs: ['medical'] },
  { id: 'modest_needs', patterns: ['modest needs'], needs: ['basic_needs'] },
  { id: 'lilly_cares', patterns: ['lilly cares'], needs: ['medical'] },
  { id: 'pfizer_pap', patterns: ['pfizer patient assistance', 'pfizer rxpathways'], needs: ['medical'] },
  { id: 'bms_pap', patterns: ['bristol myers squibb patient assistance', 'bristol-myers squibb patient assistance'], needs: ['medical'] },
  { id: 'genentech_pap', patterns: ['genentech patient foundation'], needs: ['medical'] },
  { id: 'astrazeneca_pap', patterns: ['az&me', 'astrazeneca patient assistance'], needs: ['medical'] },
])

// Flat list of every vetted identity phrase (for the recall net's SQL superset).
export const ASSISTANCE_FUNDER_PATTERNS = Object.freeze(
  NATIONAL_ASSISTANCE_FUNDERS.flatMap((f) => f.patterns),
)

/**
 * A SQL superset predicate + bound params matching any vetted funder phrase
 * against a row's sponsor OR title (lowercased). The JS `assistanceFunderNeeds`
 * then re-adjudicates each candidate (national + awardable + identity), so this
 * is a deliberate SUPERSET the caller narrows — never the final gate.
 * @param {string} alias table alias (code-owned identifier, never request input)
 * @returns {{ clause: string, params: string[] }}
 */
export function assistanceFunderSqlSuperset(alias = 'fo') {
  const a = String(alias || '').trim()
  if (a && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) throw new Error('assistanceFunderSqlSuperset: invalid alias')
  const prefix = a ? `${a}.` : ''
  const parts = []
  const params = []
  for (const p of ASSISTANCE_FUNDER_PATTERNS) {
    parts.push(`(LOWER(COALESCE(${prefix}sponsor,'')) LIKE ? OR LOWER(COALESCE(${prefix}title,'')) LIKE ?)`)
    params.push(`%${p}%`, `%${p}%`)
  }
  return { clause: `(${parts.join(' OR ')})`, params }
}

/**
 * If the row is a vetted NATIONAL, AWARDABLE assistance funder, return the array
 * of need families it serves; else null. A pointer/directory row is NOT an award
 * and returns null (directories already surface via their own REVIEW rule).
 * @param {object} row a funding_opportunities row (or a joined match+opportunity row)
 * @returns {string[]|null}
 */
export function assistanceFunderNeeds(row) {
  if (!row || typeof row !== 'object') return null
  const isNational = row.is_national === true || row.is_national === 1 || row.is_national === '1'
  if (!isNational) return null
  const kind = row.opportunity_kind ?? row.kind ?? row.opportunity_type ?? row.type
  if (isPointerKind(kind)) return null
  const hay = `${String(row.sponsor ?? '')} | ${String(row.title ?? '')}`.toLowerCase()
  if (hay.trim() === '|') return null
  for (const funder of NATIONAL_ASSISTANCE_FUNDERS) {
    if (funder.patterns.some((p) => hay.includes(p))) return [...funder.needs]
  }
  return null
}

/** Whether the row is a vetted national awardable assistance funder. */
export function isVettedNationalAssistanceFunder(row) {
  return assistanceFunderNeeds(row) !== null
}

// ── Profile side: which assistance-need families does the profile DECLARE? ──
// Structured signals only (never mined prose — a denial like "no disability" must
// not mint `disability`). MISSING = NEUTRAL: a profile that declares none simply
// gets nothing from this slice; it is never harmed.

const INDIVIDUAL_ROOT_TYPES = new Set([
  'individual', 'family', 'student', 'veteran', 'senior', 'disabled_adult', 'caregiver', 'medical_need',
])

const MEDICAL_NEED_TOKENS = new Set([
  'medical', 'health', 'healthcare', 'health_medical', 'medical_bills', 'medical_debt',
  'prescription', 'prescriptions', 'medication', 'medications', 'treatment', 'copay', 'health_care',
])
const DISABILITY_NEED_TOKENS = new Set(['disability', 'disabilities', 'disabled', 'assistive_technology', 'adaptive'])
const SENIOR_NEED_TOKENS = new Set(['senior', 'seniors', 'aging', 'elder', 'elderly', 'older_adult'])
const BASIC_NEED_TOKENS = new Set([
  'basic_needs', 'housing', 'rent', 'rental', 'food', 'nutrition', 'utilities', 'utility', 'energy',
  'financial', 'financial_assistance', 'cash_assistance', 'emergency', 'hardship', 'homeless', 'homelessness',
])

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes'
}

function collectDeclaredNeedTokens(profile, sections) {
  const tokens = new Set()
  const push = (val) => {
    if (typeof val !== 'string') return
    const t = val.trim().toLowerCase().replace(/\s+/g, '_')
    if (t) tokens.add(t)
  }
  const eat = (arr) => { if (Array.isArray(arr)) arr.forEach(push) }
  // profiles-row declared needs
  const p = profile || {}
  eat(p.needs); eat(p.need_categories)
  // structured section need arrays + a section KEY that IS a canonical need
  const secs = sections || {}
  for (const [key, data] of Object.entries(secs)) {
    push(key)
    if (data && typeof data === 'object') {
      eat(data.needs); eat(data.need_categories); eat(data.primary_needs)
      eat(data.support_needs); eat(data.funding_needs)
    }
  }
  return tokens
}

/**
 * The set of ASSISTANCE_NEED families the profile DECLARES. Individual-root
 * profiles only (an org never qualifies for individual assistance funds).
 * @returns {Set<string>}
 */
export function profileAssistanceNeeds(profile, sections) {
  const out = new Set()
  const p = profile || {}
  const rootType = String(p.primary_type ?? p.type ?? '').trim().toLowerCase()
  if (rootType && !INDIVIDUAL_ROOT_TYPES.has(rootType)) return out // orgs get nothing here
  // A null/unknown-type profile with a POSITIVE org signal is an organization,
  // not an individual — these funds serve people, so it gets nothing. (The
  // catalog's own applicant-type gate does not reliably reject an org for a
  // patient-assistance fund that states no entity_types, so guard it here.)
  if (!rootType || !INDIVIDUAL_ROOT_TYPES.has(rootType)) {
    const org = (sections && sections.organization_details) || {}
    const biz = (sections && sections.small_business_details) || {}
    const orgType = String(org.organization_type ?? '').trim()
    const bizName = String(biz.business_name ?? '').trim()
    if (orgType || bizName) return out
  }

  // Type-derived families.
  if (rootType === 'disabled_adult') { out.add('disability'); out.add('medical') }
  if (rootType === 'senior') out.add('senior')

  // Structured demographic/assistance flags.
  const demo = (sections && sections.demographics) || {}
  const disabilityStatus = String(demo.disability_status ?? '').trim().toLowerCase()
  if (disabilityStatus && disabilityStatus !== 'no disability' && disabilityStatus !== 'none' && disabilityStatus !== 'no') {
    out.add('disability'); out.add('medical')
  }
  const gov = (sections && sections.government_assistance) || {}
  if (truthy(gov.ssdi_recipient_self) || truthy(gov.ssi_recipient_self) || truthy(gov.medicaid) || truthy(gov.medicare)) {
    out.add('medical')
  }
  // A declared age >= 60 is a senior signal.
  const age = Number(demo.age ?? (sections?.basic_information || {}).age)
  if (Number.isFinite(age) && age >= 60) out.add('senior')

  // Declared need tokens → families.
  const tokens = collectDeclaredNeedTokens(p, sections)
  for (const t of tokens) {
    if (MEDICAL_NEED_TOKENS.has(t)) out.add('medical')
    if (DISABILITY_NEED_TOKENS.has(t)) { out.add('disability'); out.add('medical') }
    if (SENIOR_NEED_TOKENS.has(t)) out.add('senior')
    if (BASIC_NEED_TOKENS.has(t)) out.add('basic_needs')
  }
  // A senior is a candidate for senior + basic-needs assistance funds; a
  // disabled adult for medical/disability. Both already added above.
  return out
}

/**
 * Whether the profile's declared assistance needs OVERLAP the funder row's served
 * needs — the recall net's need-gate. MISSING (empty either side) = no overlap =
 * not linked (neutral, never harmful).
 * @param {object} row funder catalog row
 * @param {Set<string>} declaredNeeds from profileAssistanceNeeds
 * @returns {boolean}
 */
export function funderServesDeclaredNeed(row, declaredNeeds) {
  if (!(declaredNeeds instanceof Set) || declaredNeeds.size === 0) return false
  const served = assistanceFunderNeeds(row)
  if (!served) return false
  return served.some((n) => declaredNeeds.has(n))
}

export default {
  ASSISTANCE_NEED,
  NATIONAL_ASSISTANCE_FUNDERS,
  assistanceFunderNeeds,
  isVettedNationalAssistanceFunder,
  profileAssistanceNeeds,
  funderServesDeclaredNeed,
}
