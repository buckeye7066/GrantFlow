import { apiFetch } from '@/api/apiClient'

export function ingestSolicitation(payload) {
  return apiFetch('/api/solicitations/ingest', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listOpportunitySolicitations(opportunityId, profileId) {
  const params = new URLSearchParams({ profile_id: String(profileId) })
  return apiFetch(`/api/opportunities/${encodeURIComponent(opportunityId)}/solicitations?${params}`)
}

export function linkApplicationLifecycle(applicationId, payload = {}) {
  return apiFetch(`/api/applications/${encodeURIComponent(applicationId)}/lifecycle/link`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getApplicationLifecycle(applicationId) {
  return apiFetch(`/api/applications/${encodeURIComponent(applicationId)}/lifecycle`)
}

export function auditGroundedDraft(applicationId, payload) {
  return apiFetch(`/api/applications/${encodeURIComponent(applicationId)}/grounding-audit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function finalizeLifecycleDraft(draftId, payload) {
  return apiFetch(`/api/application-drafts/${encodeURIComponent(draftId)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...payload, status: 'final' }),
  })
}

export function recordOutcomeEvidence(applicationId, payload) {
  return apiFetch(`/api/applications/${encodeURIComponent(applicationId)}/outcome-evidence`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function revokeOutcomeEvidence(applicationId, evidenceId, reason) {
  return apiFetch(
    `/api/applications/${encodeURIComponent(applicationId)}/outcome-evidence/${encodeURIComponent(evidenceId)}/revoke`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    },
  )
}
