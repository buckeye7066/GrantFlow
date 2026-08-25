import { apiFetch } from './client'

export function rankResearchOpportunities(payload) {
  return apiFetch('/api/research-recommendations/rank', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
