import { apiFetch } from './client'
import { GRANT_LIST_FULL_LIMIT } from './grantListLimits'

export function listGrants(filters = {}) {
  const params = new URLSearchParams()
  // No limit means the backend's silent 100-row default page; ask for the
  // full set unless the caller chose a limit.
  if (filters.limit === undefined || filters.limit === null || filters.limit === '') {
    params.set('limit', String(GRANT_LIST_FULL_LIMIT))
  }
  Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .forEach(([key, value]) => params.set(key, String(value)))

  const query = params.toString()
  return apiFetch(`/api/grants${query ? `?${query}` : ''}`)
}

export function getGrant(grantId) {
  return apiFetch(`/api/grants/${grantId}`)
}

// Remove a grant from a profile's pipeline. Authorized for admin OR the profile
// owner (backend ensureGrantAccess). The delete is STICKY — the backend records
// a pipeline dismissal so the matcher / crawlers won't silently re-add it; a
// later manual re-add clears that tombstone.
export function deleteGrant(grantId) {
  if (!grantId) return Promise.reject(new Error('grantId required'))
  return apiFetch(`/api/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' })
}

export function getGrantAutomationEvents(grantId, { limit = 25 } = {}) {
  const params = new URLSearchParams()
  if (limit) params.set('limit', String(limit))
  const query = params.toString()
  return apiFetch(`/api/grants/${grantId}/automation/events${query ? `?${query}` : ''}`)
}

export function getLatestGrantAutomation(grantId) {
  return apiFetch(`/api/grants/${grantId}/automation/latest`)
}

export function getAutomationSummary(organizationId) {
  if (!organizationId) {
    throw new Error('organizationId is required to fetch automation summary.')
  }
  const params = new URLSearchParams()
  params.set('organization_id', String(organizationId))
  const query = params.toString()
  return apiFetch(`/api/grants/automation/summary?${query}`)
}

export function runPipelineAutomation({ grantId, profileId, organizationId } = {}) {
  if (!grantId && !organizationId && !profileId) {
    throw new Error('Provide at least one target (grantId, organizationId, or profileId).')
  }

  const parameters = {}
  if (grantId) parameters.grant_id = grantId
  if (organizationId) parameters.organization_id = organizationId

  return apiFetch('/api/crawlers/jobs', {
    method: 'POST',
    body: JSON.stringify({
      type: 'pipeline_automation',
      profile_id: profileId ?? undefined,
      parameters,
    }),
  })
}

export function createGrant(payload) {
  return apiFetch('/api/grants', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}