// Normalize explicit diagnosis-field values without changing stored answers or
// interpreting free prose. Exact aliases only; a denial remains a denial.
export function normalizeConditionTerm(value) {
  const term = String(value ?? '').trim().toLowerCase()
    .replace(/^(?:\[\s*\]\s*)+/, '')
    .replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return ['hbp', 'htn', 'high blood pressure'].includes(term) ? 'hypertension' : term
}
