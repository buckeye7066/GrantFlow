// Normalize explicit diagnosis-field values without changing stored answers or
// interpreting free prose. Exact aliases only; a denial remains a denial.
const HYPERTENSION_TERMS = ['hypertension', 'hbp', 'htn', 'high blood pressure']

// A profile's own statement of an intellectual or developmental disability.
// ICD-10 F70–F79 is intellectual disability, and "mentally challenged" is the
// legacy term profiles still use. A bare "cognitive disability" with no code is
// deliberately absent: an acquired brain injury is cognitive, not developmental.
const IDD_PROFILE_TERM_RX = /^(?:intellectual(?: and| or|\/)? ?(?:developmental )?disabilit(?:y|ies)|developmental disabilit(?:y|ies)|i\/?dd|mentally challenged|mental retardation|down syndrome|autism(?: spectrum disorder)?)$|(?<![a-z0-9])f7\d(?:\.\d+)?(?![a-z0-9])/

// How funders write the IDD requirement. An IDD diagnosis is matched against
// these as whole terms, alongside its own wording.
const IDD_TEXT_TERMS = [
  'intellectual disability', 'intellectual disabilities',
  'developmental disability', 'developmental disabilities',
  'intellectual or developmental disabilities', 'intellectual and developmental disabilities',
  'intellectual/developmental disabilities',
]

export function normalizeConditionTerm(value) {
  const term = String(value ?? '').trim().toLowerCase()
    .replace(/^(?:\[\s*\]\s*)+/, '')
    .replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return HYPERTENSION_TERMS.includes(term) ? 'hypertension' : term
}

// Opportunity prose retains the funder's wording. Compare the known diagnosis
// aliases as whole terms rather than rewriting prose or splitting an alias.
export function conditionTermVariants(value) {
  const term = normalizeConditionTerm(value)
  if (term === 'hypertension') return [...HYPERTENSION_TERMS]
  if (!term) return []
  return IDD_PROFILE_TERM_RX.test(term) ? [term, ...IDD_TEXT_TERMS] : [term]
}
