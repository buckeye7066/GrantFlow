import { apiFetch } from './client'

export function listGrants(filters = {}) {
  const params = new URLSearchParams()
  Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .forEach(([key, value]) => params.set(key, String(value)))

  const query = params.toString()
  return apiFetch(`/api/grants${query ? `?${query}` : ''}`)
}

export function getGrant(grantId) {
  return apiFetch(`/api/grants/${grantId}`)
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