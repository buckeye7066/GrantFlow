import { apiFetch } from './client'

// Award Compliance & Restriction Tracking API.
// Money is integer CENTS in every request/response. Proof of spending is an
// EXISTING uploaded document id (upload via /api/documents/ingest first).

export function listComplianceRules({ profileId, grantId } = {}) {
  const params = new URLSearchParams()
  if (profileId) params.set('profile_id', profileId)
  if (grantId) params.set('grant_id', grantId)
  const q = params.toString()
  return apiFetch(`/api/award-compliance/rules${q ? `?${q}` : ''}`)
}

export function getComplianceSummary({ profileId, grantId } = {}) {
  const params = new URLSearchParams()
  if (profileId) params.set('profile_id', profileId)
  if (grantId) params.set('grant_id', grantId)
  const q = params.toString()
  return apiFetch(`/api/award-compliance/summary${q ? `?${q}` : ''}`)
}

export function createComplianceRule(payload) {
  return apiFetch('/api/award-compliance/rules', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateComplianceRule(ruleId, payload) {
  return apiFetch(`/api/award-compliance/rules/${ruleId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function listSpendEntries(ruleId) {
  return apiFetch(`/api/award-compliance/rules/${ruleId}/spend`)
}

// payload: { amount_cents, spent_on?, category?, memo?, proof_document_id? }
export function logSpendEntry(ruleId, payload) {
  return apiFetch(`/api/award-compliance/rules/${ruleId}/spend`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function reconcileScholarship({ awardCents, schoolBillCents }) {
  return apiFetch('/api/award-compliance/scholarship-reconciliation', {
    method: 'POST',
    body: JSON.stringify({ award_cents: awardCents, school_bill_cents: schoolBillCents }),
  })
}

export function deriveComplianceRules(grantId) {
  return apiFetch(`/api/award-compliance/grants/${grantId}/derive`, {
    method: 'POST',
  })
}
