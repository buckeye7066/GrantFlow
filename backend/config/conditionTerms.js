// Normalize explicit diagnosis-field values without changing stored answers or
// interpreting free prose. Exact aliases only; a denial remains a denial.
const HYPERTENSION_TERMS = ['hypertension', 'hbp', 'htn', 'high blood pressure']

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
  return term === 'hypertension' ? [...HYPERTENSION_TERMS] : term ? [term] : []
}
