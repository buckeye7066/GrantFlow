import { apiFetch } from '@/api/apiClient'

/**
 * List grant applications for the authenticated user.
 * @param {{ profile_id?: string, status?: string, limit?: number }} [params]
 */
export function listApplications(params = {}) {
  const qs = new URLSearchParams()
  if (params.profile_id) qs.set('profile_id', String(params.profile_id))
  if (params.status) qs.set('status', String(params.status))
  if (params.limit) qs.set('limit', String(params.limit))
  const query = qs.toString()
  return apiFetch(`/api/grant-applications${query ? `?${query}` : ''}`)
}

/**
 * Create a new grant application.
 * @param {{ grant_name: string, profile_id: string, funder_name?: string, amount_requested?: number, deadline_date?: string, notes?: string, opportunity_id?: string, pipeline_grant_id?: string }} data
 */
export function createApplication(data) {
  return apiFetch('/api/grant-applications', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * Get a single grant application by ID.
 * @param {string} id
 */
export function getApplication(id) {
  return apiFetch(`/api/grant-applications/${encodeURIComponent(id)}`)
}

/**
 * Update a grant application.
 * @param {string} id
 * @param {object} data
 */
export function updateApplication(id, data) {
  return apiFetch(`/api/grant-applications/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

/**
 * Delete a grant application (only if not submitted).
 * @param {string} id
 */
export function deleteApplication(id) {
  return apiFetch(`/api/grant-applications/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/**
 * Mark an application as submitted.
 * @param {string} id
 */
export function submitApplication(id) {
  return apiFetch(`/api/grant-applications/${encodeURIComponent(id)}/submit`, {
    method: 'POST',
  })
}

/**
 * Record an outcome (awarded or denied).
 * @param {string} id
 * @param {{ outcome: 'awarded' | 'denied', amount_awarded?: number, notes?: string }} data
 */
export function recordOutcome(id, data) {
  return apiFetch(`/api/grant-applications/${encodeURIComponent(id)}/outcome`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
